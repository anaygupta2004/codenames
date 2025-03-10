Implementation of Team Voting Decision for Codenames

# Changes Made

- Added getMetaDecision function to ai-service.ts
- Integrated the function into the team voting system in routes.ts
- Function analyzes game state, history, and team discussion
- Makes strategic decisions about continuing or ending turn
- Considers correct/incorrect guesses for the current clue
- Evaluates team score and remaining words
- Supports all AI models: GPT-4, Claude, Gemini, and Grok

# Benefits

- More strategic Team Voting Decisions based on comprehensive game state
- Decision shows what was voted for: "End Turn" or "Continue"
- Better coordination between AI team members
- Improved risk assessment after successful guesses
- Smoother game flow with more informed turn management