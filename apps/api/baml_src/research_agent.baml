class TemporalValidation {
  data_as_of_date             string
  most_recent_quarter_analyzed string
}

class BaselineMetrics {
  price          float?
  pe_ratio       float?
  pb_ratio       float?
  roe            float?
  roa            float?
  eps_ttm        float?
  eps_forward    float?
  dividend_yield float?
}

class DynamicContext {
  identified_themes         string[]
  scraped_evidence          string[]
  macro_regulatory_updates  string[]
}

class ResearchOutput {
  user_original_query string
  temporal_validation TemporalValidation
  baseline_metrics    BaselineMetrics
  dynamic_context     DynamicContext
}
