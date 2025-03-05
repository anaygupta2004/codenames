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
  message string @alias("analysis")
  suggestedMoves Guess[] @alias("suggested moves")
}

enum Risk {
  High
  Medium
  Low
}

class MetaDecision {
  decision Decision
  reasoning string[]
}

enum Decision {
  Continue @description("Continue the game")
  ContunueWait @description("Continue the game, but wait for a consensus")
  EndTurn @description("End the turn")
}

class Guess {
  word string
  reasoning string
  discussion string
  risk Risk
}

class GuessDiscussion {
  candidateGuesses Guess[]
  discussionLog string[]
  conversationRounds int @description("Number of rounds of discussion that have occurred")
  participantContributions map<string, int> @description("Tracks how many times each participant has contributed")
  consensusReached bool @description("Whether consensus has been reached among participants")
  consensusLevel ConsensusLevel @description("Level of consensus among participants")
  suggestedAction Decision @description("Suggested next action based on current discussion state")
}

enum ConsensusLevel {
  High @description("All players strongly agree on the guess")
  Medium @description("Most players agree on the guess")
  Low @description("Some players disagree on the guess")
}

function GenerateClue(state: GameState) -> SpymasterClue {
  client "openai/gpt-4o"
  prompt #"
    You are the Codenames spymaster for the {{ state.currentTeam }} team.

    Your team's words: {{ state.teamWords }}
    Opposing team's words (avoid): {{ state.opposingWords }}
    Assassin word (must avoid): {{ state.assassinWord }}
    Words already revealed: {{ state.revealedCards }}

    Give a strategic one-word clue to help your team find their unrevealed words while avoiding others.

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

    Analyze this clue and suggest guesses.

    {{ ctx.output_format }}

    {{ _.role("user") }} Analyze this clue and make a recommendation.
  "#
}

function ValidateGuess(
  guess: Guess,
  clue: SpymasterClue,
  state: GameState,
  discussion: GuessDiscussion
) -> GameAnalysis {
  client "openai/gpt-4o"
  prompt #"
    You are validating a potential guess in Codenames.

    Clue given: "{{ clue.word }}" ({{ clue.number }})
    Proposed guess: "{{ guess.word }}"
    
    Current game state:
    - Team: {{ state.currentTeam }}
    - Available words: {{ state.words }}
    - Revealed cards: {{ state.revealedCards }}

    {{ ctx.output_format }}

    {{ _.role("user") }} Evaluate whether this word is a good guess based on the clue.
  "#
}

function FinalizeGuess(
  state: GameState,
  discussion: GuessDiscussion,
  clue: SpymasterClue,
  currentRound: int
) -> Guess {
  client "openai/gpt-4o"
  prompt #"
    You are a Codenames player on the {{ state.currentTeam }} team analyzing the discussion to determine if consensus has been reached.
    
    Current game state:
    - Clue: "{{ clue.word }}" ({{ clue.number }})
    - Available words: {{ state.words }}
    - Words already revealed: {{ state.revealedCards }}
    
    Discussion analysis:
    - Discussion log: {{ discussion.discussionLog }}
    - Candidate guesses: {{ discussion.candidateGuesses }}
    - Current round of conversation: {{ currentRound }}
    
    IMPORTANT: You are in round {{ currentRound }} of an ongoing multi-turn discussion.
    
    When analyzing consensus:
    1. Has every team member contributed at least once to the discussion? If not, there is no consensus yet.
    2. Is there a word that multiple team members have suggested with Medium or Low risk? This indicates emerging consensus.
    3. Calculate confidence scores for each candidate word based on frequency and risk assessments.
    4. If confidence for a word is above 75%, consensus is likely reached.
    
    Your task is to EITHER:
    
    A. Confirm consensus is reached by selecting the final guess word with reasoning and an accurate risk assessment
    OR
    B. If no consensus yet, return a "no_consensus" word, explain what's missing, and suggest what needs to be discussed next
    
    For a valid consensus, you MUST have:
    - Multiple team members supporting the same word
    - Clear reasoning why the word connects to the clue
    - Risk assessment that all participants acknowledge
    
    {{ ctx.output_format }}
    
    {{ _.role("user") }} Based on this discussion, has consensus been reached? If so, what is the final guess?
  "#
}

function ContinueDiscussion(
  state: GameState,
  clue: SpymasterClue,
  currentDiscussion: GuessDiscussion,
  participantId: string,
  participantRole: string
) -> Guess {
  client "openai/gpt-4o"
  prompt #"
    You are {{ participantId }}, a Codenames player on the {{ state.currentTeam }} team.
    
    Game state:
    - Clue given: "{{ clue.word }}" ({{ clue.number }})
    - Available words: {{ state.words }}
    - Words already revealed: {{ state.revealedCards }}
    
    IMPORTANT: This is a multi-turn conversation. You are participating in an active team discussion.
    Your role is: {{ participantRole }}
    
    Current discussion history:
    {{ currentDiscussion.discussionLog }}
    
    Current candidate guesses:
    {{ currentDiscussion.candidateGuesses }}
    
    You MUST:
    1. Address what other players have said
    2. Express agreement or disagreement with specific suggestions
    3. Suggest a concrete word if you have a strong opinion
    4. Assign a risk level to your suggestion (High/Medium/Low)
    5. Ask questions if you need more input before deciding
    
    Your contribution should move the team toward consensus. If the team is converging on a word but you have concerns about its risk level, express those concerns clearly. If you're confident about a guess, explain your reasoning in detail.
    
    {{ ctx.output_format }}
    
    {{ _.role("user") }} As {{ participantId }}, contribute to the team discussion about the clue "{{ clue.word }}".
  "#
}

function DetermineNextAction(
  state: GameState,
  currentClue: SpymasterClue,
  previousGuesses: Guess[],
  currentDiscussion: GuessDiscussion,
  consensus: ConsensusLevel,
  guessesLeft: int
) -> MetaDecision {
  client "openai/gpt-4o"
  prompt #"
    You are deciding the next action for the {{ state.currentTeam }} team in Codenames.
    
    Current state:
    - Clue: "{{ currentClue.word }}" ({{ currentClue.number }})
    - Guesses remaining for this clue: {{ guessesLeft }}
    - Previous guesses: {{ previousGuesses }}
    - Discussion logs: {{ currentDiscussion.discussionLog }}
    - Consensus level: {{ consensus }}
    
    IMPORTANT RULES:
    1. If consensus is High and the risk is Low/Medium, the team should Continue (make the guess)
    2. If consensus is Medium or the risk is High, additional discussion may be needed (ContunueWait)
    3. If consensus is Low after multiple rounds, the team may need to EndTurn
    4. If the team has already guessed {{ currentClue.number }} words, they should EndTurn
    5. If all participants have contributed multiple times with no consensus, EndTurn
    
    Make a decision based on the state of the discussion:
    - Are all team members active in the discussion?
    - Has the discussion stalled on the same points?
    - Is there a clear consensus emerging?
    - What is the risk level of the leading guess?
    
    Provide detailed reasoning for your decision, especially if you recommend ending the turn.
    
    {{ ctx.output_format }}
    
    {{ _.role("user") }} Based on the current discussion state, what should the team do next?
  "#
}

function ExecuteGuess(
  state: GameState,
  clue: SpymasterClue,
  finalGuess: Guess,
  currentDiscussion: GuessDiscussion
) -> Guess {
  client "openai/gpt-4o"
  prompt #"
    You are executing the final guess for the {{ state.currentTeam }} team in Codenames.
    
    Current state:
    - Clue: "{{ clue.word }}" ({{ clue.number }})
    - The team has reached consensus on: "{{ finalGuess.word }}"
    - Risk assessment: {{ finalGuess.risk }}
    
    Team discussion summary:
    {{ currentDiscussion.discussionLog }}
    
    IMPORTANT: You are submitting this guess as the team's official move. This action cannot be undone.
    
    Before confirming:
    1. Verify the word is still on the board (not already revealed)
    2. Confirm that multiple team members support this guess
    3. Acknowledge the risk level and its implications
    
    Provide a final statement that:
    - Announces the team's decision to the game
    - Summarizes why the team believes this word connects to the clue
    - Acknowledges the consensus process that led to this decision
    
    {{ ctx.output_format }}
    
    {{ _.role("user") }} Execute the final guess "{{ finalGuess.word }}" for the {{ state.currentTeam }} team.
  "#
}
