"""Context window sizes for known models."""

# Context window sizes by model identifier
# Source: Anthropic model documentation
MODEL_CONTEXT_WINDOWS: dict[str, int] = {
    # Claude 4 family (current)
    "claude-sonnet-4-20250514": 200_000,
    "claude-opus-4-20250514": 200_000,
    # Claude 3.5 family
    "claude-3-5-sonnet-20241022": 200_000,
    "claude-3-5-haiku-20241022": 200_000,
    # Claude 3 family
    "claude-3-opus-20240229": 200_000,
    "claude-3-sonnet-20240229": 200_000,
    "claude-3-haiku-20240307": 200_000,
    # Aliases for convenience
    "claude-sonnet": 200_000,
    "claude-opus": 200_000,
    "claude-haiku": 200_000,
    "sonnet": 200_000,
    "opus": 200_000,
    "haiku": 200_000,
}

DEFAULT_CONTEXT_WINDOW = 200_000  # Fallback for unknown models
