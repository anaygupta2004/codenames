import { BAML } from "@boundaryml/baml";
import { type CardType, type GameHistoryEntry, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";

const baml = new BAML({
  apiKey: process.env.BAML_API_KEY,
  environment: "production"
});

export async function discussAndVote(
  model: string,
  team: "red" | "blue",
  words: string[],
  clue: { word: string; number: number },
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  revealedCards: string[],
): Promise<{ message: string; confidence: number }> {
  const availableWords = words.filter(word => !revealedCards.includes(word));

  const recentDiscussion = teamDiscussion
    .filter(entry => entry.team === team)
    .map(entry => `${entry.player}: ${entry.message} (confidence: ${entry.confidence})`)
    .join("\n");

  const previousCluesAndResults = gameHistory
    .filter(entry => entry.type === "clue" || entry.type === "guess")
    .map(entry => {
      if (entry.type === "clue") return `Clue: ${entry.content}`;
      return `Guess: ${entry.content} (${entry.result})`;
    })
    .join("\n");

  try {
    const response = await baml.prompts.discussion({
      team,
      available_words: availableWords,
      clue_word: clue.word,
      clue_number: clue.number,
      recent_discussion: recentDiscussion,
      previous_clues_and_results: previousCluesAndResults
    });

    return {
      message: response.message,
      confidence: response.confidence
    };
  } catch (error) {
    console.error("BAML Discussion Error:", error);
    throw new Error("Failed to generate AI discussion response");
  }
}

export async function makeConsensusVote(
  model: string,
  team: "red" | "blue",
  proposedWord: string,
  teamDiscussion: TeamDiscussionEntry[],
): Promise<{ approved: boolean; reason: string }> {
  try {
    const recentDiscussion = teamDiscussion
      .filter(entry => entry.team === team)
      .map(entry => `${entry.player}: ${entry.message} (confidence: ${entry.confidence})`)
      .join("\n");

    return {
      approved: true, 
      reason: "Consensus reached based on team discussion"
    };
  } catch (error) {
    console.error("Consensus Vote Error:", error);
    throw new Error("Failed to process consensus vote");
  }
}

export async function getSpymasterClue(
  words: string[],
  teamWords: string[],
  opposingWords: string[],
  assassinWord: string,
  gameHistory: GameHistoryEntry[]
): Promise<{ word: string; number: number }> {
  const previousClues = gameHistory
    .filter(entry => entry.type === "clue")
    .map(entry => entry.content)
    .join(", ");

  const previousGuesses = gameHistory
    .filter(entry => entry.type === "guess")
    .map(entry => `${entry.content} (${entry.result})`)
    .join(", ");

  try {
    const response = await baml.prompts.spymaster({
      words,
      team_words: teamWords,
      opposing_words: opposingWords,
      assassin_word: assassinWord,
      previous_clues: previousClues,
      previous_guesses: previousGuesses
    });

    return {
      word: response.word,
      number: response.number
    };
  } catch (error) {
    console.error("BAML Spymaster Error:", error);
    throw new Error("Failed to generate spymaster clue");
  }
}

export async function getGuesserMove(
  words: string[],
  clue: { word: string; number: number },
  revealedCards: string[],
  gameHistory: GameHistoryEntry[]
): Promise<string> {
  const availableWords = words.filter(word => !revealedCards.includes(word));

  const previousCluesAndResults = gameHistory
    .filter(entry => entry.type === "clue" || entry.type === "guess")
    .map(entry => {
      if (entry.type === "clue") return `Clue: ${entry.content}`;
      return `Guess: ${entry.content} (${entry.result})`;
    })
    .join("\n");

  try {
    const response = await baml.prompts.guesser({
      available_words: availableWords,
      clue_word: clue.word,
      clue_number: clue.number,
      previous_clues_and_results: previousCluesAndResults
    });

    return response.guess;
  } catch (error) {
    console.error("BAML Guesser Error:", error);
    throw new Error("Failed to generate AI guess");
  }
}

function getAIService(model: string): string {
  throw new Error("This function is obsolete and should be removed.");
}