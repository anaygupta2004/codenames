// Codenames AI Prompts

@prompt("spymaster")
fn get_spymaster_clue {
  input {
    words: string[]
    team_words: string[]
    opposing_words: string[]
    assassin_word: string
    previous_clues: string
    previous_guesses: string
  }
  
  output {
    word: string
    number: number
  }

  client openai {
    model = "gpt-4o"
    temperature = 0.7
    response_format = { type = "json_object" }
  }

  template {
    """
    As a Codenames spymaster, analyze these game elements:
    Board words: {{words | join(", ")}}
    My team's words: {{team_words | join(", ")}}
    Opposing team's words: {{opposing_words | join(", ")}}
    Assassin word: {{assassin_word}}

    Game History:
    Previous clues given: {{previous_clues || "None"}}
    Previous guesses made: {{previous_guesses || "None"}}

    Give a one-word clue and a number indicating how many words it relates to.
    The clue must follow Codenames rules:
    - Must be a single word
    - Cannot be any form of the visible words
    - Should connect multiple team words if possible
    - Avoid words that might lead to opponent or assassin words
    - Avoid words similar to previously failed clues

    Respond in JSON format: { "word": "clue", "number": count }
    """
  }
}

@prompt("guesser")
fn get_guesser_move {
  input {
    available_words: string[]
    clue_word: string
    clue_number: number
    previous_clues_and_results: string
  }

  output {
    guess: string
  }

  client openai {
    model = "gpt-4o"
    temperature = 0.7
    response_format = { type = "json_object" }
  }

  template {
    """
    As a Codenames guesser, analyze:
    Available words: {{available_words | join(", ")}}
    Current clue word: {{clue_word}}
    Current clue number: {{clue_number}}

    Game History:
    {{previous_clues_and_results}}

    Choose the word that best matches the clue, considering:
    1. Previous successful and failed guesses
    2. Pattern of clues given
    3. Words that remain unrevealed

    Respond in JSON format: { "guess": "chosen_word" }
    """
  }
}

@prompt("discussion")
fn discuss_and_vote {
  input {
    team: string
    available_words: string[]
    clue_word: string
    clue_number: number
    recent_discussion: string
    previous_clues_and_results: string
  }

  output {
    message: string
    confidence: number
  }

  client openai {
    model = "gpt-4o"
    temperature = 0.7
    response_format = { type = "json_object" }
  }

  template {
    """
    As a Codenames AI player, analyze the team discussion:

    Current clue: "{{clue_word}}" ({{clue_number}})
    Available words: {{available_words | join(", ")}}

    Team Discussion:
    {{recent_discussion}}

    Game History:
    {{previous_clues_and_results}}

    1. Analyze the other team members' suggestions
    2. Consider their confidence levels
    3. State your opinion about the best word choice
    4. Express your confidence level (0-1)
    5. If you disagree with others, explain why

    Respond in JSON format: { "message": "your detailed analysis", "confidence": number }
    """
  }
}
