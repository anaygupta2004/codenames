class SpymasterClue {
  word string @description("The one-word clue given by the spymaster")
  number int @description("Number of words related to the clue")
  reasoning string @description("Explanation for the chosen clue")
}

class GameState {
  currentTeam "red" | "blue"
  words string[]
  teamWords string[] @description("Words belonging to the current team")
  opposingWords string[] @description("Words belonging to the opposing team")
  assassinWord string
  revealedCards string[]
}

class GameAnalysis {
  message string @description("The AI's analysis of the game state")
  suggestedMove string? @description("Suggested word to guess if applicable")
  moveConfidence "high" | "medium" | "low" @description("Confidence in the suggested move")
}

function GenerateClue(state: GameState) -> SpymasterClue {
  client "openai/gpt-4o"
  prompt #"
    You are the Codenames spymaster for the {{ state.currentTeam }} team.

    Your team's words: {{ state.teamWords }}
    Opposing team's words (avoid): {{ state.opposingWords }}
    Assassin word (must avoid): {{ state.assassinWord }}
    Words already revealed: {{ state.revealedCards }}

    Give a strategic one-word clue to help your team find their words while avoiding others.

    {{ ctx.output_format }}

    {{ _.role("user") }} Based on these words, provide a strategic clue and number.
  "#
}

function AnalyzeClue(
  clue: SpymasterClue,
  state: GameState
) -> GameAnalysis {
  client "anthropic/claude-3-5-sonnet-latest"
  prompt #"
    You are a Codenames player on the {{ state.currentTeam }} team.
    
    The spymaster has given the clue: "{{ clue.word }}" ({{ clue.number }})

    Available words: {{ state.words }}
    Words already revealed: {{ state.revealedCards }}

    Analyze this clue and suggest whether to guess any words.

    {{ ctx.output_format }}

    {{ _.role("user") }} Analyze this clue and make a recommendation.
  "#
}

function ValidateGuess(
  word: string,
  clue: SpymasterClue,
  state: GameState,
  model: string
) -> GameAnalysis {
  client "openai/gpt-4o"
  prompt #"
    You are validating a potential guess in Codenames.

    Clue given: "{{ clue.word }}" ({{ clue.number }})
    Proposed guess: "{{ word }}"
    
    Current game state:
    - Team: {{ state.currentTeam }}
    - Available words: {{ state.words }}
    - Revealed cards: {{ state.revealedCards }}

    {{ ctx.output_format }}

    {{ _.role("user") }} Evaluate whether this word is a good guess based on the clue.
  "#
}