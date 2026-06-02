class WebAction {
  action string @description("click | type | scroll | highlight")
  element_id int? @description("ID from the element map. Null only for scroll with no target.")
  value string? @description("Text to type. Required when action is type.")
  direction string? @description("up | down. Required when action is scroll.")
  amount int? @description("Pixels to scroll. Required when action is scroll.")
  text_snippet string? @description("Exact text to highlight. Required when action is highlight.")
  isCritical bool @description("True for buy/sell/withdraw/deposit/confirm.")
  description string @description("What this action does and why. Max 10 words.")
}

class StepRecord {
  step_number int
  action_description string
  outcome string @description("succeeded | failed")
  screenshot_before image @description("Page state before this action.")
}

class WebAgentStep {
  reasoning string @description("One sentence max.")
  needs_element_map bool @description("True if you need the element map to proceed. Set this when next_action requires a click, type, or highlight but no element map was provided. False for scroll, verify, or when element map is already present. When true, set next_action=null.")
  next_action WebAction? @description("Null if needs_element_map is true, is_complete is true, or is_failed is true.")
  is_complete bool @description("True ONLY when you can visually confirm the task is already done or your last action completed it. Never true on the same turn you set next_action.")
  is_failed bool @description("True if the task is impossible, stuck, or the same action has failed twice.")
}


function WebAgentNextStep(
  task: string,
  elementMap: string?,
  screenshot: image,
  history: StepRecord[],
) -> WebAgentStep {
  client GPT54Mini
  prompt #"
    You are a web automation agent. One action per turn.

    REASONING ORDER — follow this exactly:
    1. Look at the screenshot first. Understand what is currently visible on screen.
    2. Check the history to understand what has been tried.
    3. Decide what to do next.

    RULES:
    - needs_element_map: Set true when you need to click, type, or highlight but no element map is provided. You will be called again with the element map before acting.
    - element_id MUST exist in the element map — never invent one.
    - If target not in map, reveal it first (scroll, open menu).
    - is_complete: ONLY set true when you are on a verify turn — you just received a screenshot after your last action and can visually confirm the task is done. NEVER set is_complete on the same turn you output a next_action.
    - is_failed: Set if stuck, same action failed twice, or task is impossible.
    - isCritical: True for buy/sell/withdraw/deposit/confirm actions.

    {{ _.role("user") }}
    Task: {{ task }}

    {% if history|length > 0 %}
    Recent steps (max 3):
    {% for s in history %}
    Step {{ s.step_number }}: {{ s.action_description }} → {{ s.outcome }}
    Before: {{ s.screenshot_before }}
    {% endfor %}
    {% endif %}

    Current page:
    {{ screenshot }}

    {% if elementMap %}
    Elements (only these IDs are valid):
    {{ elementMap }}
    {% else %}
    No element map provided. If you need to click, type, or highlight, set needs_element_map=true and next_action=null. You may scroll without the element map.
    {% endif %}

    {{ ctx.output_format }}
  "#
}
