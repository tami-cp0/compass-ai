generator my_client {
  output_type "typescript"
  output_dir ".."
  version "0.75.0"
}

client<llm> GPT4o {
  provider openai
  options {
    model "gpt-4o"
    api_key env.OPENAI_API_KEY
  }
}
