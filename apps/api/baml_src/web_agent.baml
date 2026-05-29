class WebAction {
  action string @description("click | type | scroll | highlight")
  element_id int? @description("ID from the element map. Null only for full-page scroll.")
  value string? @description("Text to type. Required when action is type.")
  direction string? @description("up | down. Required when action is scroll.")
  amount int? @description("Pixels to scroll. Required when action is scroll.")
  text_snippet string? @description("Exact text to highlight. Required when action is highlight.")
  isCritical bool @description("True if this is a buy, sell, withdraw, or confirm action. Extension will block and request user confirmation.")
  description string @description("One sentence describing what this action does and why.")
}

class WebAgentOutput {
  actions WebAction[] @description("Ordered list of actions to perform to complete the task.")
}

function WebAgent(task: string, elementMap: string, screenshot: string) -> WebAgentOutput {
  client GPT4o
  prompt #"
    You are the web automation agent for a financial trading platform.
    You receive a task, a map of interactable elements on the page (each with a unique element_id), and a screenshot for visual context.

    Use the element map as the source of truth for targeting. Never guess element IDs.
    Use the screenshot to understand spatial layout and describe what you see if needed.

    Task: {{ task }}

    Interactable elements:
    {{ elementMap }}

    Rules:
    - Output only the actions needed to complete the task. No extra steps.
    - Set isCritical=true for any buy, sell, withdraw, deposit, or confirm action.
    - For scroll: set element_id to the scrollable container, or null to scroll the main window.
    - For highlight: text_snippet must be an exact substring of the element's text content.
    {{ ctx.output_format }}
  "#
}
