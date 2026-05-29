generator my_client {
  output_type "typescript"
  output_dir ".."
  version "0.75.0"
}

client<llm> Claude {
  provider anthropic
  options {
    model "claude-sonnet-4-6"
    api_key env.ANTHROPIC_API_KEY
  }
}
