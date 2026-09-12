"""Shared declarative registry; executors are trusted code, never model code."""
import json
import math
import os
from pathlib import Path

REGISTRY_PATH = Path(__file__).resolve().parents[2] / "video-composer-frontend/src/agent/toolRegistry.json"
REGISTRY = {tool["name"]: tool for tool in json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))}


def validate_schema(value, schema, path="arguments"):
    kind = schema["type"]
    valid = {
        "object": isinstance(value, dict), "array": isinstance(value, list),
        "string": isinstance(value, str), "boolean": isinstance(value, bool),
        "number": type(value) in (int, float),
        "integer": type(value) in (int, float) and math.isfinite(value) and value == int(value),
    }[kind]
    if not valid:
        raise ValueError(f"{path} must be {kind}.")
    if kind == "object":
        properties = schema.get("properties", {})
        if set(value) - properties.keys() or set(schema.get("required", [])) - value.keys():
            raise ValueError(f"{path} has unexpected or missing fields.")
        for key, item in value.items():
            validate_schema(item, properties[key], f"{path}.{key}")
    elif kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 1000):
            raise ValueError(f"{path} has an invalid length.")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            raise ValueError(f"{path} must contain unique items.")
        for item in value:
            validate_schema(item, schema["items"], path)
    elif kind == "string":
        if not schema.get("minLength", 0) <= len(value.strip()) <= schema.get("maxLength", 5000):
            raise ValueError(f"{path} has an invalid length.")
    elif kind in ("number", "integer"):
        if not math.isfinite(value) or not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
            raise ValueError(f"{path} is outside the supported range.")
        if schema.get("multipleOf") and value % schema["multipleOf"]:
            raise ValueError(f"{path} must be a multiple of {schema['multipleOf']}.")


def tool_definitions(recording_state="idle", mode=None, generate_assets=False):
    if mode not in (None, "edit", "plan"):
        raise ValueError("Choose Edit Video or Plan New Video.")
    result = []
    for tool in REGISTRY.values():
        available, reason = True, ""
        if mode and mode not in tool["modes"]:
            result.append({**tool, "available": False, "unavailable_reason": "This tool is not available in this mode. Switch to Plan New Video to plan or generate footage."})
            continue
        if tool["availability"] == "recording" and recording_state != "recording":
            available, reason = False, "No recording is active. Use Record to start one."
        if tool["availability"] == "service":
            prefix = tool["service"]
            missing = [name for name in (f"{prefix}_SERVICE_URL", f"{prefix}_API_KEY") if not os.getenv(name, "").strip()]
            if missing:
                available, reason = False, "Missing backend configuration: " + ", ".join(missing) + ". " + tool["alternative"]
        configured = available
        if mode == "plan" and tool["name"] in {"generate_image", "generate_video"} and not generate_assets and available:
            available, reason = False, "Enable the optional Generate Assets step to use this configured service. Each job still requires approval."
        result.append({**tool, "available": available, "configured": configured, "unavailable_reason": reason})
    return result


def validate_call(call, recording_state="idle", mode=None, generate_assets=False):
    if not isinstance(call, dict) or set(call) - {"id", "name", "arguments", "depends_on"}:
        raise ValueError("Invalid tool call fields.")
    if not isinstance(call.get("id"), str) or not 1 <= len(call["id"]) <= 100:
        raise ValueError("Each tool call needs a stable ID.")
    tool = next((t for t in tool_definitions(recording_state, mode, generate_assets) if t["name"] == call.get("name")), None)
    if not tool:
        raise ValueError("Unknown tool. Only registered tools may execute.")
    if not tool["available"]:
        raise ValueError(tool["unavailable_reason"])
    validate_schema(call.get("arguments"), tool["arguments"])
    dependencies = call.get("depends_on", [])
    if not isinstance(dependencies, list) or any(not isinstance(d, str) for d in dependencies) or len(dependencies) > 24:
        raise ValueError("depends_on must be a list of call IDs.")
    return tool
