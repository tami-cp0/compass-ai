class VoiceAgentInput {
  summary string @description("Compressed history of all older turns")
  recentTurns string @description("Last 3 turns verbatim as formatted text")
  userMessage string @description("Current user utterance")
  domSnapshot string? @description("Page DOM snapshot if available")
  researchResult string? @description("Research result if available")
  actionError string? @description("Action failure description if an action failed")
}

class VoiceAgentOutput {
  response string @description("What to say to the user")
  tool string? @description("Tool to invoke: request_dom_snapshot | browser_action | research | null")
  toolInput string? @description("JSON-encoded input for the tool")
}

function VoiceAgent(input: VoiceAgentInput) -> VoiceAgentOutput {
  client Claude
  prompt #"
    You are Compass, an AI voice assistant for a financial trading platform.
    You help users navigate the platform, place trades, and research stocks.

    Conversation history (summary of older turns):
    {{ input.summary }}

    Recent turns:
    {{ input.recentTurns }}

    {% if input.domSnapshot %}
    Current page context:
    {{ input.domSnapshot }}
    {% endif %}

    {% if input.researchResult %}
    Research result:
    {{ input.researchResult }}
    {% endif %}

    {% if input.actionError %}
    An action failed:
    {{ input.actionError }}
    {% endif %}

    User: {{ input.userMessage }}

    Respond naturally and concisely. If you need to act on the page, set tool to browser_action.
    If you need to research, set tool to research. If you need the page context, set tool to request_dom_snapshot.
    {{ ctx.output_format }}
  "#
}
