"""Accumulate a goal brief independently of staged editing transactions."""
import re
import uuid
from math import gcd

FIELDS = ("subject", "audience", "key_message", "duration_seconds", "format")
ESSENTIALS = ("subject", "audience", "key_message")
QUESTIONS = {
    "subject": "What subject or product should the promotional video feature?",
    "audience": "Who is the promotional video for?",
}


def merge_brief(brief, update):
    if not isinstance(brief, dict) or not isinstance(update, dict) or set(update) - set(FIELDS):
        raise ValueError("Invalid brief fields.")
    result = {field: brief.get(field) for field in FIELDS}
    for field, value in update.items():
        if value is None or value == "":
            continue  # Omission is never a request to clear an earlier answer.
        if field == "duration_seconds":
            if type(value) not in (float, int) or not 0 < value <= 1800:
                raise ValueError("Brief duration must be between 0 and 1800 seconds.")
        elif not isinstance(value, str) or len(value) > 2000:
            raise ValueError("Brief values must be short text.")
        else:
            value = value.strip().rstrip(' ,.!?;\t\n')
            if not value:
                continue
            if field == "audience":
                value = value.lower()
        result[field] = value
    return result


def goal_context(data):
    prompt = str(data.get("prompt") or "")
    kind = data.get("goal_kind")
    if kind not in (None, "promotional_video"):
        raise ValueError("Invalid goal kind.")
    promotional = bool(re.search(r"\b(promo(?:tional)?|advert(?:isement|ising)?|commercial)\b", prompt, re.I))
    creation = re.search(r"\b(create|build|produce|start|make (?:a|an|another|new))\b", prompt, re.I) and re.search(r"\b(video|promo|advertisement|commercial)\b", prompt, re.I) and not re.search(r"\b(actually|instead|correction)\b", prompt, re.I)
    new_goal = data.get("round", 0) == 0 and bool(creation or re.search(r"\b(new|another|different)\s+(?:(?:short|promotional|promo)\s+)*(?:goal|video|promo|advertisement|commercial)\b|\bstart (?:over|again)\b", prompt, re.I))
    brief = merge_brief({}, data.get("brief") or {})
    pending = data.get("pending_clarification")
    if new_goal:
        brief, pending, kind = merge_brief({}, {}), None, "promotional_video" if promotional else kind if re.search(r"start (?:over|again)", prompt, re.I) else None
    if promotional:
        kind = "promotional_video"
    # Compatibility for callers which have not merged the short reply themselves.
    if data.get("round", 0) == 0 and kind == "promotional_video":
        update = {}
        duration = re.search(r"\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)\b", prompt, re.I)
        if duration:
            update["duration_seconds"] = float(duration[1]) * (60 if duration[2].lower().startswith("min") else 1)
        for key, label in (("subject", "subject|product"), ("audience", "audience|target audience"), ("key_message", "key message|main message|message"), ("format", "format")):
            match = re.search(rf"(?:{label})\s*(?:is|:|=|to)\s*(.+)", prompt, re.I)
            if match:
                update[key] = match[1]
        field = pending.get("field") if isinstance(pending, dict) else None
        correction = re.match(r"(?:actually|instead|change|update|make|set|keep|use|it should|the duration)\b", prompt, re.I)
        if field in ESSENTIALS and not correction and not any(key in update for key in ("subject", "audience", "key_message", "format")):
            answer = (prompt[:duration.start()] + prompt[duration.end():] if duration else prompt).strip().rstrip(' ,.!?;\t\n')
            if answer:
                update[field] = answer
        brief = merge_brief(brief, update)
    if kind == "promotional_video":
        brief["duration_seconds"] = brief["duration_seconds"] or 30
        composition = data["composition"]
        width, height = composition.get("width", 1280), composition.get("height", 720)
        if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
            raise ValueError("Composition dimensions must be positive integers.")
        divisor = gcd(width, height)
        brief["format"] = brief["format"] or f"{width // divisor}:{height // divisor}"
    return {"goal_id": str(uuid.uuid4() if new_goal else data.get("goal_id") or uuid.uuid4()), "goal_kind": kind,
            "brief": brief, "pending_clarification": pending, "new_goal": new_goal,
            "scene_plan_approved": not new_goal and (data.get("scene_plan_approved") is True or any(
                r.get("name") == "plan_scenes" and r.get("status") == "success" for r in data.get("tool_results", []) if isinstance(r, dict)))}


def complete_goal_response(plan, goal):
    updated = {**goal, "brief": merge_brief(goal["brief"], plan.pop("brief_update", {}))}
    if updated["goal_kind"] == "promotional_video":
        missing = next((field for field in ESSENTIALS if not updated["brief"][field]), None)
        if missing:
            question = QUESTIONS[missing] if missing != "key_message" else f"What key message should {updated['brief']['audience']} take away?"
            plan = {"status": "clarify", "goal": plan.get("goal", "Promotional video"), "message": question, "calls": []}
            updated["pending_clarification"] = {"field": missing, "question": question}
        else:
            updated["pending_clarification"] = None
    else:
        updated["pending_clarification"] = {"question": plan["message"]} if plan["status"] == "clarify" else None
    return {**plan, **updated}
