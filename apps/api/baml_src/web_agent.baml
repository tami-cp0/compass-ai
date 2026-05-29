class Coords {
  x int
  y int
}

class WebAction {
  kind string @description("click | type | scroll")
  selector string? @description("CSS selector for the target element")
  coords Coords? @description("Pixel coordinates as fallback")
  value string? @description("Text to type if kind is type")
  isCritical bool @description("True if this is a buy/sell/withdraw/confirm action")
  description string @description("Human-readable description of what this action does")
}

class WebAgentOutput {
  actions WebAction[] @description("Ordered list of actions to perform")
}

function WebAgent(task: string, domSnapshot: string) -> WebAgentOutput {
  client Claude
  prompt #"
    You are the web automation agent for a financial trading platform.
    Given a task and the current page context, produce the precise actions needed.

    Task: {{ task }}

    Page context:
    {{ domSnapshot }}

    Produce an ordered list of actions. Mark isCritical=true for any buy, sell, withdraw, or confirm action.
    {{ ctx.output_format }}
  "#
}
