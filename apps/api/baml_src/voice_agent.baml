class VoiceAgentInput {
  summary string @description("Compressed history of all older turns")
  recentTurns string @description("Last 3 turns verbatim as formatted text")
  userMessage string @description("Current user utterance")
  automationDescription string? @description("What the web agent is currently doing, e.g. 'Looking for the order book'. Null if no automation is running.")
  researchDescription string? @description("What is currently being researched, e.g. 'DANGCEM Q3 earnings'. Null if no research is running.")
  screenshot string? @description("Base64 PNG screenshot of the current page. Use this to describe what you see visually.")
  researchResult string? @description("Completed research result if research just finished")
  actionError string? @description("Action failure description if a web agent action failed")
}

class VoiceAgentOutput {
  response string @description("What to say to the user")
  tool string? @description("Tool to invoke: request_dom_snapshot | browser_action | research | null")
  browserActionTask string? @description("Required when tool is browser_action. A clear description of what the web agent should do, e.g. 'Find the order form and fill the quantity field with 500'.")
  researchQuestion string? @description("Required when tool is research. The exact question to research, e.g. 'What are DANGCEM Q3 2024 earnings?'.")
}

function VoiceAgent(input: VoiceAgentInput) -> VoiceAgentOutput {
  client Claude
  prompt #"
    You are Compass, an AI voice assistant for a financial trading platform.
    You help users navigate the platform, place trades, and research stocks.
    When referring to automation or research, speak in first person — say "I am currently doing X", not "the tool is doing X".

    Conversation history (summary of older turns):
    {{ input.summary }}

    Recent turns:
    {{ input.recentTurns }}

    {% if input.automationDescription %}
    Web automation is currently in progress: {{ input.automationDescription }}
    {% endif %}

    {% if input.researchDescription %}
    Research is currently in progress: {{ input.researchDescription }}
    {% endif %}

    {% if input.screenshot %}
    Current page (screenshot):
    {{ input.screenshot }}
    {% endif %}

    {% if input.researchResult %}
    Research result:
    {{ input.researchResult }}
    {% endif %}

    {% if input.actionError %}
    A web action failed:
    {{ input.actionError }}
    {% endif %}

    User: {{ input.userMessage }}

    Respond naturally and concisely.
    - If automation or research is in progress and the user asks what you are doing, answer from the state fields above — do not call a tool.
    - If you need to act on the page, set tool to browser_action and describe the task clearly in browserActionTask.
    - If you need to research, set tool to research and write the exact question in researchQuestion.
    - If you need a screenshot of the current page, set tool to request_dom_snapshot.
    {{ ctx.output_format }}
  "#
}
