generator my_client {
  output_type "typescript"
  output_dir ".."
  version "0.75.0"
}

client<llm> GPT54Mini {
  provider openai
  options {
    model "gpt-5.4-mini"
    api_key env.OPENAI_API_KEY
    max_completion_tokens 4096
  }
}
