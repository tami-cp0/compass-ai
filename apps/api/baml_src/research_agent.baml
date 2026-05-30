class ResearchOutput {
  summary string @description("Concise factual summary of findings, ordered by relevance")
  sources string[] @description("URLs or source names consulted")
}

function ResearchAgent(question: string) -> ResearchOutput {
  client GPT4o
  prompt #"
    You are the research agent for a financial trading platform.
    Answer the following question with concise, factual information.
    Focus on recent data. No filler and only output data from credible sources

    Question: {{ question }}

    {{ ctx.output_format }}
  "#
}
