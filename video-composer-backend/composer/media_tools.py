"""Configured service gateway contract. No model-supplied endpoints or executable code."""
import base64
import hashlib
import json
import os
import urllib.parse
import urllib.request
import uuid

from django.core import signing
from django.core.files.base import ContentFile
from .models import AgentOperation
from .tool_registry import validate_call

MAX_INPUT = 20 * 1024 * 1024
MAX_RESPONSE = 70 * 1024 * 1024
SALT = "video-agent-service-approval-v1"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Service redirects are disabled.")


def prepare_operation(data):
    call = data.get("call")
    tool = validate_call(call)
    if tool["executor"] != "service":
        raise ValueError("This endpoint only executes configured media services.")
    operation_id, run_id = uuid.UUID(data["operation_id"]), uuid.UUID(data["run_id"])
    digest = data.get("media_digest", "")
    if tool["name"] == "transcribe" and (not isinstance(digest, str) or len(digest) != 64):
        raise ValueError("Transcription requires the selected media's SHA-256 digest.")
    endpoint = os.getenv(f"{tool['service']}_SERVICE_URL", "")
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError(f"{tool['service']}_SERVICE_URL must be an HTTPS gateway URL without embedded credentials.")
    # Bind approval to exact arguments, source bytes, endpoint and operation identity.
    fingerprint = hashlib.sha256(json.dumps([call["name"], call["arguments"], digest, endpoint], sort_keys=True).encode()).hexdigest()
    existing = AgentOperation.objects.filter(id=operation_id).first()
    if not existing and AgentOperation.objects.filter(run_id=run_id).count() >= 4:
        raise ValueError("At most four media service operations are allowed per request.")
    operation, _ = AgentOperation.objects.get_or_create(id=operation_id, defaults={
        "run_id": run_id, "fingerprint": fingerprint, "tool": call["name"],
        "arguments": {"arguments": call["arguments"], "media_digest": digest, "endpoint": endpoint},
    })
    if operation.fingerprint != fingerprint or operation.run_id != run_id:
        raise ValueError("An operation ID cannot be reused for different arguments.")
    return {
        "operation_id": str(operation.id),
        "approval_token": signing.dumps({"id": str(operation.id), "fingerprint": fingerprint}, salt=SALT),
        "tool": call["name"], "arguments": call["arguments"],
        "provider": parsed.hostname,
        "cost_notice": os.getenv(f"{tool['service']}_COST_NOTICE", "").strip() or "This service may charge your account. An exact price is not configured.",
        "sends_source_media": tool["name"] == "transcribe",
    }


def execute_operation(token, upload=None):
    approved = signing.loads(token, salt=SALT, max_age=900)
    operation = AgentOperation.objects.get(id=approved["id"], fingerprint=approved["fingerprint"])
    if operation.status == "success":
        return operation.result
    if operation.status != "awaiting_confirmation":
        raise ValueError("This operation is already running or its outcome is uncertain. It will not be submitted again; check the service account.")
    call = {"id": str(operation.id), "name": operation.tool, "arguments": operation.arguments["arguments"]}
    tool = validate_call(call)
    endpoint = os.getenv(f"{tool['service']}_SERVICE_URL", "")
    if endpoint != operation.arguments["endpoint"]:
        raise ValueError("Service configuration changed. A new confirmation is required.")
    payload = {"tool": operation.tool, "arguments": call["arguments"], "operation_id": str(operation.id)}
    if operation.tool == "transcribe":
        if not upload or upload.size > MAX_INPUT:
            raise ValueError("Select an audio/video file no larger than 20 MB for transcription.")
        if not upload.content_type.startswith(("audio/", "video/")):
            raise ValueError("Transcription requires audio or video.")
        content = upload.read(MAX_INPUT + 1)
        if hashlib.sha256(content).hexdigest() != operation.arguments["media_digest"]:
            raise ValueError("Selected media changed after confirmation.")
        payload["media"] = {"mime_type": upload.content_type, "base64": base64.b64encode(content).decode()}
    # Atomic compare-and-set survives concurrent duplicate HTTP requests and worker restarts.
    if not AgentOperation.objects.filter(id=operation.id, status="awaiting_confirmation").update(status="processing"):
        raise ValueError("This operation has already been submitted.")
    try:
        result = SERVICE_EXECUTORS[operation.tool](tool, endpoint, payload)
        if operation.tool == "transcribe":
            transcript = result.get("text")
            if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 20000:
                raise ValueError("Invalid transcript response.")
            receipt = {"text": transcript, "operation_id": str(operation.id)}
        else:
            mime = result.get("mime_type")
            allowed = {
                "generate_image": {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"},
                "generate_video": {"video/mp4": "mp4", "video/webm": "webm"},
                "text_to_speech": {"audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg"},
            }[operation.tool]
            if mime not in allowed:
                raise ValueError("Service returned an unsupported media type.")
            content = base64.b64decode(result["base64"], validate=True)
            if not content or len(content) > 50 * 1024 * 1024:
                raise ValueError("Generated media must be between 1 byte and 50 MB.")
            name = f"{operation.id}.{allowed[mime]}"
            operation.output.save(name, ContentFile(content), save=False)
            receipt = {"asset_id": f"generated-{operation.id}", "url": operation.output.url,
                       "name": name, "type": mime, "operation_id": str(operation.id)}
        operation.result, operation.status = receipt, "success"
        operation.save(update_fields=["result", "status", "output"])
        return receipt
    except Exception as exc:
        AgentOperation.objects.filter(id=operation.id).update(status="uncertain")
        # Do not expose upstream bodies, endpoints, keys, or retry a potentially billed call.
        raise ValueError("Media service failed or returned an invalid result. No timeline changes were committed. The job may have been billed; check the service account before starting another job.") from exc


def call_gateway(tool, endpoint, payload):
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {os.environ[tool['service'] + '_API_KEY']}",
        "Idempotency-Key": payload["operation_id"],
    }, method="POST")
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
        raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ValueError("Service response exceeds the size limit.")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("Service must return a JSON object.")
    return result


# Separate capabilities with the same explicit gateway wire contract.
SERVICE_EXECUTORS = {name: call_gateway for name in ("transcribe", "text_to_speech", "generate_image", "generate_video")}
