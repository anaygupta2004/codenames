import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { b } from '../../baml_client'
import { type GameHistoryEntry, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";
import dotenv from 'dotenv';
import pkg from 'lodash';
const { debounce } = pkg;

dotenv.config();

let openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY 
});

let anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY 
});

let genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'dummy-key-for-dev');

export type AIModel = "gpt-4o" | "claude-sonnet-4-5-20250929" | "grok-4-fast-reasoning" | "gemini-1.5-pro";
export type AIService = "openai" | "anthropic" | "xai" | "google";

const VALID_MODELS = ["gpt-4o", "claude-sonnet-4-5-20250929", "grok-4-fast-reasoning", "gemini-1.5-pro"];

function validateModel(model: string): AIModel {
  if (!VALID_MODELS.includes(model)) {
    throw new Error(`Invalid AI model: ${model}. Valid models are: ${VALID_MODELS.join(", ")}`);
  }
  return model as AIModel;
}

function getAIService(model: AIModel): AIService {
  if (model === "gpt-4o") return "openai";
  if (model === "claude-sonnet-4-5-20250929") return "anthropic";
  if (model === "grok-4-fast-reasoning") return "xai";
  if (model === "gemini-1.5-pro") return "google";
  throw new Error(`Invalid AI model: ${model}`);
}

// Add sanitization helper
function sanitizeJsonResponse(text: string): string {
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

// Update Gemini functions
async function getGeminiDiscussion(prompt: string): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ 
          text: `${prompt}\n\nRespond ONLY with a JSON object in this format:
{
  "message": "your analysis of the clue and suggested words",
  "confidence": 0.8,
  "suggestedWord": "WORD"
}`
        }] 
      }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.8,
        topK: 40,
      }
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      if (!parsed.message || typeof parsed.confidence !== "number") {
        throw new Error("Invalid response format");
      }
      return parsed;
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      // If parsing fails, try to extract JSON from the response
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Clean up any trailing commas that might cause parse errors
        const cleanJson = jsonMatch[0].replace(/,(\s*[}\]])/g, '$1');
        try {
          const extracted = JSON.parse(cleanJson);
          if (extracted.message && typeof extracted.confidence === "number") {
            return extracted;
          }
        } catch (e) {
          // If we still can't parse it, throw the original error
          throw parseError;
        }
      }
      // If all else fails, return a formatted error response
      return {
        message: "Error processing response",
        confidence: 0,
        suggestedWord: undefined
      };
    }
  } catch (error) {
    console.error("Error in Gemini discussion:", error);
    return {
      message: "Failed to get response from Gemini",
      confidence: 0,
      suggestedWord: undefined
    };
  }
}

async function getGeminiGuess(prompt: string): Promise<{ guess: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ 
          text: `${prompt}\n\nRespond ONLY with a JSON object in this format:
{
  "guess": "THE_WORD_YOU_WANT_TO_GUESS"
}`
        }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      if (!parsed.guess || typeof parsed.guess !== "string") {
        throw new Error("Invalid response format");
      }
      return parsed;
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      // Try to extract JSON if response contains explanation text
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        if (extracted.guess && typeof extracted.guess === "string") {
          return extracted;
        }
      }
      throw new Error("Failed to parse Gemini guess response");
    }
  } catch (error) {
    console.error("Error in Gemini guess:", error);
    throw new Error("Failed to get guess from Gemini");
  }
}

async function getGeminiVote(prompt: string): Promise<{ approved: boolean; reason: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ 
          text: `${prompt}\n\nRespond ONLY with a JSON object in this format:
{
  "approved": true or false,
  "reason": "explanation for your decision"
}`
        }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      if (typeof parsed.approved !== "boolean" || typeof parsed.reason !== "string") {
        throw new Error("Invalid response format");
      }
      return parsed;
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      // Try to extract JSON if response contains explanation text
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        if (typeof extracted.approved === "boolean" && typeof extracted.reason === "string") {
          return extracted;
        }
      }
      return {
        approved: false,
        reason: "Error processing vote response"
      };
    }
  } catch (error) {
    console.error("Error in Gemini vote:", error);
    return {
      approved: false,
      reason: "Error processing vote response"
    };
  }
}

// Update the main functions to include Gemini
const GAME_RULES = `
Codenames Rules:
1. The board has 25 words - some belong to red team, some to blue team, some are neutral, and one is the assassin
2. CRITICAL: Only the spymaster knows which words belong to which team - team members CANNOT see word assignments!
3. Team members only see a grid of words without knowing which team owns which word
4. The spymaster gives a one-word clue and a number indicating how many words relate to that clue
5. Team members must guess based ONLY on their spymaster's clue, with no knowledge of word assignments
6. Team members can make multiple guesses for a clue if they're confident (up to the number given + 1)
7. If a wrong word is guessed, the turn ends immediately
8. Guessing the assassin word loses the game instantly
9. First team to find all their words wins
10. Strategic elements:
   - Spymaster must connect multiple team words while avoiding opponent words
   - Spymaster must NEVER assume teammates know which words to avoid
   - Team members must analyze clues carefully without seeing word assignments
   - The entire game hinges on the spymaster providing clear clues that uniquely identify their team's words`;

export async function getSpymasterClue(
  model: string | AIModel,
  words: string[],
  teamWords: string[],
  opposingWords: string[],
  assassinWord: string,
  gameHistory: GameHistoryEntry[] | null | undefined,
  gameState: GameState | null | undefined,
  redScore: number | undefined,
  blueScore: number | undefined,
  revealedCards: string[] = [],
  useBackgroundThinking: boolean = true
): Promise<{ word: string; number: number; reasoning?: string }> {
  // First check if we should use the background thinking cache
  if (useBackgroundThinking && gameState) {
    // Determine which team we're generating a clue for
    const currentTeam = gameState.currentTurn === "red_turn" ? "red" : "blue";
    const gameId = gameState.gameId;
    
    // Try to get the best cached clue from our continuous background thinking
    const bestClue = getBestSpymasterClue(gameId, currentTeam);
    
    if (bestClue) {
      console.log(`🏆 Using cached best clue from background thinking: ${bestClue.word} (${bestClue.number}) with score ${bestClue.score.toFixed(2)}`);
      return {
        word: bestClue.word,
        number: bestClue.number,
        reasoning: bestClue.reasoning
      };
    } else {
      console.log(`⚠️ No cached clues available, generating new clue on demand`);
    }
  }
  
  // Ensure model is valid
  const validatedModel = validateModel(model);
  
  // Safely handle undefined gameState and gameHistory
  const safeGameHistory = Array.isArray(gameHistory) ? gameHistory : [];
  const safeGameState = gameState || 'unknown';
  
  // Determine current turn more safely
  let currentTeam = "red"; // Default to red if we can't determine
  if (typeof safeGameState === 'string') {
    currentTeam = safeGameState.includes("red") ? "red" : "blue";
  } else if (safeGameState && typeof safeGameState === 'object' && safeGameState.currentTeam) {
    currentTeam = safeGameState.currentTeam;
  } else if (safeGameHistory.length > 0 && safeGameHistory[safeGameHistory.length - 1].turn) {
    // Extract from last history entry
    const lastTurn = safeGameHistory[safeGameHistory.length - 1].turn;
    currentTeam = typeof lastTurn === 'string' && lastTurn.includes("red") ? "red" : "blue";
  }
  
  // Create a unique key for the cache based on game state
  const cacheKey = `${validatedModel}-${currentTeam}-${teamWords.join(",")}-${revealedCards.join(",")}`;
  const gameStateHash = `${redScore}-${blueScore}-${revealedCards.length}`;
  
  // Check if we have a cached clue from background thinking
  if (useBackgroundThinking && spymasterThinkingCache.has(cacheKey)) {
    const cachedThinking = spymasterThinkingCache.get(cacheKey)!;
    
    // Only use the cached clue if it's from the current game state
    if (cachedThinking.gameState === gameStateHash && Date.now() - cachedThinking.timestamp < 5 * 60 * 1000) {
      console.log(`Using cached spymaster clue from background thinking: ${cachedThinking.clue.word} (${cachedThinking.clue.number})`)
      return cachedThinking.clue;
    }
  }
  
  const teamScore = currentTeam === "red" ? redScore : blueScore;
  const oppositeScore = currentTeam === "red" ? blueScore : redScore;
  const wordsRemaining = teamWords.length;
  
  // Analyze previous clues and their effectiveness
  const previousCluesWithResults = new Map<string, {
    success: number, 
    failure: number, 
    words: string[]
  }>();
  
  // Track all words guessed (correctly or incorrectly) for each clue
  const clueToWordsMap = new Map<string, Set<string>>();
  
  // Extract previous clues and analyze patterns
  safeGameHistory.filter(entry => entry.type === "clue").forEach(clueEntry => {
    const clue = clueEntry.content;
    const relatedGuesses = safeGameHistory.filter(g => 
      g.type === "guess" && 
      g.relatedClue === clue && 
      g.word !== undefined
    );
    
    // Track success/failure for this clue
    const successCount = relatedGuesses.filter(g => g.result === "correct").length;
    const failureCount = relatedGuesses.filter(g => g.result !== "correct").length;
    
    // Track words guessed for this clue
    const wordsGuessed = new Set(relatedGuesses.map(g => g.word || '').filter(w => w));
    clueToWordsMap.set(clue, wordsGuessed);
    
    previousCluesWithResults.set(clue, {
      success: successCount,
      failure: failureCount,
      words: Array.from(wordsGuessed)
    });
  });
  
  // For spymaster - determine which words of their team are still unrevealed
  const unrevealed = teamWords.filter(word => !revealedCards.includes(word));
  
  // Find active (previous) clues with remaining unguessed words
  const activeClues = Array.from(previousCluesWithResults.entries())
    .map(([clue, results]) => {
      const guessedWords = clueToWordsMap.get(clue) || new Set();
      const remainingWords = teamWords.filter(w => !guessedWords.has(w) && !revealedCards.includes(w));
      return {
        clue,
        remainingWords,
        successRate: results.success / (results.success + results.failure || 1)
      };
    })
    .filter(clue => clue.remainingWords.length > 0);
  
  // Analyze word similarities and patterns to avoid
  const allRevealedWords = revealedCards.length > 0 ? revealedCards : 
    safeGameHistory
      .filter(entry => entry.type === "guess" && entry.word)
      .map(entry => entry.word!);

  // Determine game situation to adjust strategy
  const gamePhase = wordsRemaining <= 3 ? "endgame" : 
                    wordsRemaining <= 5 ? "midgame" : "earlygame";
  
  const teamLeading = teamScore > oppositeScore;
  const scoreDifference = Math.abs(teamScore - oppositeScore);
  
  // Build strategy recommendation based on game state
  let strategyRecommendation = "";
  if (gamePhase === "endgame") {
    if (teamLeading) {
      strategyRecommendation = "Be conservative with lower numbers (1-2) to minimize risk of mistakes.";
    } else if (scoreDifference > 2) {
      strategyRecommendation = "Take risks with higher numbers (3+) to catch up quickly.";
    }
  }
  
  const prompt = `${GAME_RULES}

As the spymaster for the ${currentTeam} team, you must thoroughly analyze the current game state and think deeply about word connections:

CRITICAL SPYMASTER RULES:
- YOUR TEAMMATES DO NOT KNOW WHICH WORDS BELONG TO WHICH TEAM
- Your teammates have NO IDEA which words are your team's, opponent's, neutral, or the assassin
- The entire point of the game is that your teammates must GUESS based ONLY on your clue
- NEVER assume your teammates know to avoid any word - they cannot see the color assignments!
- DO NOT reference "avoiding opponent words" in your reasoning - your teammates don't know which words those are

GAME SITUATION:
- Game phase: ${gamePhase.toUpperCase()}
- Score: Red ${redScore} - Blue ${blueScore} (${teamLeading ? "you're ahead" : "you're behind"} by ${scoreDifference})
- Words remaining for your team: ${wordsRemaining}
- Strategy recommendation: ${strategyRecommendation}

BOARD CONFIGURATION (ONLY YOU CAN SEE THIS):
- Your team's UNREVEALED words (THESE ARE YOUR TARGET WORDS): ${unrevealed.join(", ")}
- Your team's revealed words: ${teamWords.filter(word => revealedCards.includes(word)).join(", ")}
- Opposing team's words (YOU MUST AVOID THESE): ${opposingWords.join(", ")}
- Assassin word (CRITICAL TO AVOID): ${assassinWord}
- Neutral words: ${words.filter(w => !teamWords.includes(w) && !opposingWords.includes(w) && w !== assassinWord).join(", ")}
- Already revealed cards (everyone can see these): ${revealedCards.join(", ")}

HISTORICAL ANALYSIS:
- Previous clues and their effectiveness:
${Array.from(previousCluesWithResults.entries()).map(([clue, results]) => 
  `  "${clue}": ${results.success} correct, ${results.failure} wrong, words: [${results.words.join(', ')}]`
).join('\n')}

- Active clues with remaining words:
${activeClues.length > 0
  ? activeClues.map(c => `  "${c.clue}": ${c.remainingWords.length} words remaining, success rate: ${(c.successRate * 100).toFixed(0)}%`).join('\n')
  : "  None"}

ADVANCED STRATEGIC CONSIDERATIONS:
1. DEEPLY ANALYZE your team's words to find non-obvious conceptual connections between them
2. Consider multiple DIMENSIONS of meaning for each word - linguistic, cultural, metaphorical, etc.
3. Evaluate COMPOUND WORDS, IDIOMS, and FIGURATIVE connections that might link multiple team words
4. Think about shared CATEGORIES, ATTRIBUTES, FUNCTIONS, or CONTEXTS between your words
5. Your clue should exhibit DIVERGENT THINKING - consider unusual but clear associations
6. Analyze each potential guess through the eyes of EACH TEAM MEMBER, considering their likely interpretations
7. Carefully weigh AMBIGUITY vs. PRECISION based on game state

DEEP RISK ASSESSMENT (CRITICAL):
- For EACH potential clue, methodically analyze how it might connect to:
  1. Each of your team's words (desired strong connections)
  2. Each of the opponent's words (must avoid these connections)
  3. The assassin word (absolutely must avoid ANY connection)
  4. Neutral words (acceptable wrong guesses but still best avoided)
- Consider how your teammates would interpret the clue with ZERO knowledge of color assignments
- Analyze multiple interpretations and word senses for each potential connection
- Consider what information your team already has from previous rounds
- Think deeply about both DENOTATIVE and CONNOTATIVE meanings

${gamePhase === "endgame" ? "THIS IS ENDGAME - be extra cautious with your clue selection and risk assessment!" : ""}

Provide your clue in JSON format: { "word": "clue", "number": count, "reasoning": "detailed explanation of your strategy, word connections, and risk assessment" }`;

  switch (getAIService(validatedModel)) {
    case "openai":
      return await getOpenAIClue(prompt);
    case "anthropic":
      return await getAnthropicClue(prompt);
    case "xai":
      return await getXAIClue(prompt);
    case "google":
      return await getGeminiClue(prompt);
    default:
      throw new Error("Invalid AI model");
  }
}

// Enhanced guesser move function with memory, timing, and action awareness
export async function getGuesserMove(
  model: AIModel,
  words: string[],
  clue: { word: string; number: number },
  revealedCards: string[],
  gameHistory: GameHistoryEntry[],
  currentTurnStartTime: Date,
  turnTimeLimit: number,
  previousGuessesThisTurn: number,
  gameId: number = 1 // Default game ID
): Promise<{ 
  action: "guess" | "end_turn"; 
  guess?: string; 
  reasoning: string;
  confidence: number;
}> {
  const availableWords = words.filter(word => !revealedCards.includes(word));
  const currentTime = new Date();
  const timeElapsedInTurn = Math.floor((currentTime.getTime() - currentTurnStartTime.getTime()) / 1000);
  const timeRemainingInTurn = Math.max(0, turnTimeLimit - timeElapsedInTurn);
  
  // Track current team and get team history
  const currentTeam = gameHistory[gameHistory.length - 1]?.turn || "red";
  const teamHistory = gameHistory.filter(entry => entry.turn === currentTeam);
  
  // Track recent guesses and their success for the current turn
  const currentTurnGuesses = teamHistory
    .filter(entry => 
      entry.type === "guess" && 
      entry.word && // Ensure word is defined
      entry.timestamp >= currentTurnStartTime.getTime()
    )
    .map(entry => ({
      word: entry.word!,
      result: entry.result || "unknown",
      relatedClue: entry.relatedClue
    }));
  
  // Track ALL previous clues (including from previous turns) and their associated guesses
  const allCluesWithGuesses = new Map<string, {
    timestamp: number;
    guessedWords: string[];
    correctGuesses: string[];
    wrongGuesses: string[];
    numWordsHinted: number;
    active: boolean;
  }>();
  
  // Process all clues in the game history to maintain memory across turns
  gameHistory
    .filter(entry => entry.type === "clue" && entry.turn === currentTeam)
    .forEach(clueEntry => {
      const clueContent = clueEntry.content;
      // Extract number from clue format like "word (3)"
      const numWordsHintedMatch = clueContent.match(/\((\d+)\)$/);
      const numWordsHinted = numWordsHintedMatch ? parseInt(numWordsHintedMatch[1]) : 1;
      
      // Find all guesses related to this clue
      const relatedGuesses = gameHistory.filter(g => 
        g.type === "guess" && 
        g.relatedClue === clueContent && 
        g.word // ensure word is defined
      );
      
      const correctGuesses = relatedGuesses
        .filter(g => g.result === "correct")
        .map(g => g.word!)
        .filter(w => w);
      
      const wrongGuesses = relatedGuesses
        .filter(g => g.result !== "correct")
        .map(g => g.word!)
        .filter(w => w);
      
      const allGuessedWords = relatedGuesses
        .map(g => g.word!)
        .filter(w => w);
      
      // A clue is active if there are still words to guess for it
      const active = correctGuesses.length < numWordsHinted;
      
      allCluesWithGuesses.set(clueContent, {
        timestamp: clueEntry.timestamp,
        guessedWords: allGuessedWords,
        correctGuesses,
        wrongGuesses,
        numWordsHinted,
        active
      });
    });
  
  // Format active clues (from any turn) that still have remaining words to guess
  const activeClues = Array.from(allCluesWithGuesses.entries())
    .filter(([_, data]) => data.active)
    .map(([clueContent, data]) => {
      // Strip the number from the clue for display
      const baseClue = clueContent.replace(/\s*\(\d+\)$/, "");
      return {
        clue: baseClue,
        guessedWords: data.guessedWords,
        correctGuesses: data.correctGuesses,
        wrongGuesses: data.wrongGuesses,
        remainingGuesses: data.numWordsHinted - data.correctGuesses.length,
        timestamp: data.timestamp
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
  
  // Identify previous clues that might still be relevant
  const recentActiveClues = activeClues
    .slice(0, 3) // Focus on the most recent active clues
    .filter(c => c.remainingGuesses > 0);
  
  // Current clue specific information
  const currentClueBase = clue.word.replace(/\s*\(\d+\)$/, "");
  const currentClueData = allCluesWithGuesses.get(clue.word);
  const guessesRemainingForCurrentClue = clue.number - (previousGuessesThisTurn || 0);
  
  // Format time information for the AI to understand timing constraints
  const timeInfo = {
    turnDuration: turnTimeLimit,
    timeElapsed: timeElapsedInTurn,
    timeRemaining: timeRemainingInTurn,
    timePerRemainingGuess: guessesRemainingForCurrentClue > 0 
      ? Math.floor(timeRemainingInTurn / guessesRemainingForCurrentClue) 
      : 0
  };

  const prompt = `${GAME_RULES}

As a Codenames operative on the ${currentTeam} team, you need to make a strategic decision:
- Guess a word related to the current clue
- Consider previous clues that still have unguessed words
- Or end your turn if you're uncertain

CURRENT GAME STATE:
- Current clue: "${currentClueBase}" (${clue.number})
- You've already made ${previousGuessesThisTurn} guesses this turn
- Guesses remaining for current clue: ${guessesRemainingForCurrentClue}
- Available words: ${availableWords.join(", ")}
- Revealed words: ${revealedCards.join(", ")}

TIME CONSTRAINTS:
- Turn time limit: ${timeInfo.turnDuration} seconds
- Time elapsed: ${timeInfo.timeElapsed} seconds
- Time remaining: ${timeInfo.timeRemaining} seconds
- Time per remaining guess: ~${timeInfo.timePerRemainingGuess} seconds

TEAM HISTORY - ALL RELATED CLUES:
${recentActiveClues.map(c => 
  `Clue "${c.clue}" (${c.remainingGuesses} words remain): 
   - Correct guesses: ${c.correctGuesses.join(", ") || "None"}
   - Wrong guesses: ${c.wrongGuesses.join(", ") || "None"}`
).join("\n\n")}

CURRENT TURN GUESSES:
${currentTurnGuesses.length > 0 
  ? currentTurnGuesses.map(g => `- "${g.word}" (${g.result})`).join("\n") 
  : "No guesses made this turn yet"}

PREVIOUS TURN INSIGHTS:
${Array.from(allCluesWithGuesses.entries())
  .filter(([_, data]) => !data.active && data.correctGuesses.length > 0)
  .slice(0, 3)
  .map(([clue, data]) => {
    const baseClue = clue.replace(/\s*\(\d+\)$/, "");
    return `Clue "${baseClue}": Connected to ${data.correctGuesses.join(", ")}`;
  }).join("\n")}

AVAILABLE ACTIONS:
1. Guess a word from the board that relates to the current clue "${currentClueBase}"
2. Consider guessing a word related to a previous clue that still has unguessed words
3. End your turn if you're uncertain or if the risk is too high

IMPORTANT ANALYSIS GUIDELINES:
- Carefully analyze the semantic meaning of the clue "${currentClueBase}"
- Consider all available words and how strongly they relate to the clue
- Think about both direct and indirect relationships to the clue
- Consider the context of previous guesses and their results
- Analyze the risk level of each potential guess
- Remember that guessing wrong ends your turn immediately

Based on your analysis, you must decide whether to guess a word or end your turn.
- If you decide to guess, provide the word and your reasoning
- If you decide to end your turn, explain why

Respond in JSON format with one of these structures:
For guessing: { "action": "guess", "guess": "chosen_word", "reasoning": "detailed explanation", "confidence": 0.0-1.0 }
For ending turn: { "action": "end_turn", "reasoning": "detailed explanation", "confidence": 0.0-1.0 }`;

  const response = await getAIDecisionWithAction(model, prompt);
  
  // Validate response to ensure we never have undefined guesses
  if (response.action === "guess" && (!response.guess || response.guess === "undefined")) {
    console.error("Invalid guess response received:", response);
    return {
      action: "end_turn",
      reasoning: "Unable to determine a valid guess word. Ending turn as a precaution.",
      confidence: 0.1
    };
  }
  
  return response;
}

// Helper function to get AI decision with action
async function getAIDecisionWithAction(
  model: AIModel, 
  prompt: string
): Promise<{ 
  action: "guess" | "end_turn"; 
  guess?: string; 
  reasoning: string;
  confidence: number;
}> {
  try {
    switch (getAIService(model)) {
      case "openai":
        return await getOpenAIGuessWithAction(prompt);
      case "anthropic":
        return await getAnthropicGuessWithAction(prompt);
      case "xai":
        return await getXAIGuessWithAction(prompt);
      case "google":
        return await getGeminiGuessWithAction(prompt);
      default:
        throw new Error("Invalid AI model");
    }
  } catch (error) {
    console.error(`Error getting AI decision: ${error}`);
    // Safe fallback
    return {
      action: "end_turn",
      reasoning: "An error occurred while processing the decision. Ending turn as a precaution.",
      confidence: 0.1
    };
  }
}

// Implementation for each model
async function getOpenAIGuessWithAction(prompt: string): Promise<{ 
  action: "guess" | "end_turn"; 
  guess?: string; 
  reasoning: string;
  confidence: number;
}> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  const result = JSON.parse(content);
  validateActionResponse(result);
  return result;
}

async function getAnthropicGuessWithAction(prompt: string): Promise<{ 
  action: "guess" | "end_turn"; 
  guess?: string; 
  reasoning: string;
  confidence: number;
}> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'I am a Codenames AI assistant. I will respond with either a guess action or end turn action in valid JSON format.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in response");
    }

    const result = JSON.parse(jsonMatch[0]);
    validateActionResponse(result);
    return result;
  } catch (error) {
    console.error("Error parsing Anthropic action response:", error);
    throw new Error("Failed to parse Anthropic action response");
  }
}

async function getXAIGuessWithAction(prompt: string): Promise<{ 
  action: "guess" | "end_turn"; 
  guess?: string; 
  reasoning: string;
  confidence: number;
}> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  const result = JSON.parse(content);
  validateActionResponse(result);
  return result;
}

async function getGeminiGuessWithAction(prompt: string): Promise<{ 
  action: "guess" | "end_turn"; 
  guess?: string; 
  reasoning: string;
  confidence: number;
}> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ 
          text: `${prompt}\n\nRespond ONLY with a JSON object in this format:
For guessing: { "action": "guess", "guess": "chosen_word", "reasoning": "detailed explanation", "confidence": 0.0-1.0 }
For ending turn: { "action": "end_turn", "reasoning": "detailed explanation", "confidence": 0.0-1.0 }`
        }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      validateActionResponse(parsed);
      return parsed;
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        validateActionResponse(extracted);
        return extracted;
      }
      throw new Error("Failed to parse Gemini guess action response");
    }
  } catch (error) {
    console.error("Error in Gemini guess action:", error);
    throw new Error("Failed to get action from Gemini");
  }
}

function validateActionResponse(response: any): void {
  if (!response.action || !["guess", "end_turn"].includes(response.action)) {
    throw new Error(`Invalid action: ${response.action}`);
  }
  
  if (response.action === "guess" && !response.guess) {
    throw new Error("Guess action missing guess word");
  }
  
  if (!response.reasoning) {
    response.reasoning = response.action === "guess" 
      ? `Guessing "${response.guess}" based on clue analysis.`
      : "Ending turn due to uncertainty.";
  }
  
  if (typeof response.confidence !== "number") {
    response.confidence = response.action === "guess" ? 0.7 : 0.5;
  }
}

// Enhanced discussion function with memory, multi-word suggestions, and conflict resolution
export async function discussAndVote(
  model: AIModel,
  team: "red" | "blue",
  words: string[],
  clue: { word: string; number: number },
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  revealedCards: string[],
  conversationRound: number = 1,
  participantRole: string = "team member",
  teamScore: number = 0,
  opposingTeamScore: number = 0,
  currentTurnStartTime: Date = new Date(),
  turnTimeLimit: number = 60,
  guessesThisTurn: number = 0,
  gameId: number = 1 // Default game ID
): Promise<{ 
  message: string; 
  confidence: number; 
  suggestedWord?: string; 
  suggestedWords?: string[]; // NEW: Support for multiple word suggestions
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
}> {
  // Calculate time information
  const currentTime = new Date();
  const timeElapsedInTurn = Math.floor((currentTime.getTime() - currentTurnStartTime.getTime()) / 1000);
  const timeRemainingInTurn = Math.max(0, turnTimeLimit - timeElapsedInTurn);
  
  // Update team memory
  updateDiscussionMemory(gameId, team, clue, teamDiscussion, gameHistory, revealedCards, conversationRound);
  
  // Get advanced consensus metrics with conflict detection
  const consensusInfo = {
    previousClueOptions: getActiveClues(gameId, team),
    hasUnresolvedConflicts: false,
    conflictWords: [] as string[]
  };
  
  // Extract participating agents and track contribution
  const participants = new Set<string>();
  const participantContributions = new Map<string, number>();
  teamDiscussion.forEach(entry => {
    participants.add(entry.player);
    const count = participantContributions.get(entry.player) || 0;
    participantContributions.set(entry.player, count + 1);
  });
  
  // Get full discussion formatted with roles and confidence 
  const fullDiscussion = teamDiscussion
    .map(d => {
      const confidenceLabel = d.confidence > 0.8 ? "(very confident)" : 
                            d.confidence > 0.6 ? "(confident)" : 
                            d.confidence > 0.4 ? "(moderate)" : 
                            "(uncertain)";
      const riskLabel = d.risk ? `[Risk: ${d.risk}]` : "";
      const roundLabel = d.round ? `[Round ${d.round}]` : "";
      return `${d.player} ${confidenceLabel} ${roundLabel}: ${d.message}${d.suggestedWord ? ` [Suggests: ${d.suggestedWord}] ${riskLabel}` : ""}`;
    })
    .join('\n');

  // Parse advanced discussion patterns
  const discussionPatterns = analyzeDiscussionPatterns(teamDiscussion);
  
  // Track suggested words and their metrics
  const wordSuggestions = new Map<string, {
    mentions: number,
    supporters: string[],
    opposers: string[],
    confidence: number,
    risk: RiskLevel,
    fromPreviousClue: boolean,
    sourceClue?: string,
    relatedWords: string[]
  }>();
  
  // First pass: collect all word suggestions from current discussion
  teamDiscussion.forEach(entry => {
    // Process suggestedWord if available
    if (entry.suggestedWord && !revealedCards.includes(entry.suggestedWord)) {
      processWordSuggestion(entry.suggestedWord, entry, discussionPatterns, wordSuggestions);
    }
    
    // Process suggestedWords array if available - this is a critical improvement
    if (entry.suggestedWords && entry.suggestedWords.length > 0) {
      entry.suggestedWords.forEach((word, index) => {
        if (!revealedCards.includes(word)) {
          // For multiple suggestions, we apply a confidence modifier based on position
          // First word has highest confidence, decreasing for subsequent words
          const confidenceModifier = Math.max(0.3, 1 - (index * 0.15));
          const adjustedEntry = {
            ...entry,
            suggestedWord: word,
            confidence: entry.confidence * confidenceModifier
          };
          
          processWordSuggestion(word, adjustedEntry, discussionPatterns, wordSuggestions);
        }
      });
    }
  });

  // Helper function to process a word suggestion
  function processWordSuggestion(
    word: string, 
    entry: TeamDiscussionEntry, 
    discussionPatterns: any, 
    wordSuggestions: Map<string, any>
  ) {
    // Check if this word is from a previous clue
    const fromPreviousClue = discussionPatterns.mentionedPreviousClues.some(prevClue => 
      entry.message.toLowerCase().includes(prevClue.toLowerCase()) && 
      entry.message.toLowerCase().includes(word.toLowerCase())
    );
    
    if (!wordSuggestions.has(word)) {
      wordSuggestions.set(word, {
        mentions: 0,
        supporters: [],
        opposers: [],
        confidence: 0,
        risk: entry.risk || "Medium",
        fromPreviousClue,
        sourceClue: fromPreviousClue ? discussionPatterns.mentionedPreviousClues.find(pc => 
          entry.message.toLowerCase().includes(pc.toLowerCase())
        ) : undefined,
        relatedWords: []
      });
    }
    
    const wordData = wordSuggestions.get(word)!;
    wordData.mentions++;
    
    // Determine support or opposition based on confidence and message content
    const msgLower = entry.message.toLowerCase();
    const isExplicitSupport = 
      msgLower.includes("suggest") || 
      msgLower.includes("recommend") || 
      msgLower.includes("confident") ||
      msgLower.includes("good match") ||
      msgLower.includes("strong connection") ||
      msgLower.includes("vote for");
    
    const isExplicitOpposition = 
      msgLower.includes("risky") || 
      msgLower.includes("don't think") || 
      msgLower.includes("not sure") || 
      msgLower.includes("dangerous") ||
      msgLower.includes("avoid") ||
      msgLower.includes("opponent") ||
      msgLower.includes("against");
    
    // Add to appropriate category based on confidence or explicit language
    if (entry.confidence >= 0.6 || isExplicitSupport) {
      if (!wordData.supporters.includes(entry.player)) {
        wordData.supporters.push(entry.player);
      }
      wordData.confidence += entry.confidence;
    } else if (entry.confidence < 0.3 || isExplicitOpposition) {
      if (!wordData.opposers.includes(entry.player)) {
        wordData.opposers.push(entry.player);
      }
    }
    
    // Update risk assessment (prioritize higher risk)
    if (entry.risk === "High" || (entry.risk === "Medium" && wordData.risk === "Low")) {
      wordData.risk = entry.risk;
    }
  }
  
  // Add words from relevant previous clues that weren't explicitly mentioned
  consensusInfo.previousClueOptions.forEach(prevClue => {
    prevClue.suggestedWords.forEach(word => {
      if (!wordSuggestions.has(word) && !revealedCards.includes(word)) {
        console.log(`🔍 Adding word "${word}" from previous clue "${prevClue.clue}" to consideration`);
        wordSuggestions.set(word, {
          mentions: 1, // Lower initial mentions
          supporters: [], // Start with no supporters in current discussion
          opposers: [],
          confidence: 0.5, // Moderate default confidence
          risk: "Medium", // Default risk
          fromPreviousClue: true,
          sourceClue: prevClue.clue,
          relatedWords: []
        });
      }
    });
  });
  
  // Second pass: analyze disagreements and conflicts
  if (discussionPatterns.disagreements.length > 0) {
    discussionPatterns.disagreements.forEach(disagreement => {
      // Mark as having unresolved conflicts
      consensusInfo.hasUnresolvedConflicts = true;
      
      if (disagreement.word1 && disagreement.word2) {
        consensusInfo.conflictWords.push(disagreement.word1, disagreement.word2);
        
        // Add opposing agents to each word
        const word1Data = wordSuggestions.get(disagreement.word1);
        const word2Data = wordSuggestions.get(disagreement.word2);
        
        if (word1Data && !word1Data.opposers.includes(disagreement.agent2)) {
          word1Data.opposers.push(disagreement.agent2);
        }
        
        if (word2Data && !word2Data.opposers.includes(disagreement.agent1)) {
          word2Data.opposers.push(disagreement.agent1);
        }
      }
    });
  }
  
  // Find related words for each suggestion
  for (const [word, data] of wordSuggestions.entries()) {
    // Words are related if they share supporters or are mentioned together
    const relatedWords = new Set<string>();
    
    // Check for words with common supporters
    for (const [otherWord, otherData] of wordSuggestions.entries()) {
      if (otherWord !== word) {
        // Check for common supporters
        const commonSupporters = data.supporters.filter(s => otherData.supporters.includes(s));
        if (commonSupporters.length > 0) {
          relatedWords.add(otherWord);
        }
      }
    }
    
    // Check if words were mentioned together in the same message
    teamDiscussion.forEach(entry => {
      if (entry.message.toLowerCase().includes(word.toLowerCase())) {
        // This message mentions our word, check for other words
        for (const otherWord of wordSuggestions.keys()) {
          if (otherWord !== word && entry.message.toLowerCase().includes(otherWord.toLowerCase())) {
            relatedWords.add(otherWord);
          }
        }
      }
    });
    
    data.relatedWords = Array.from(relatedWords);
  }
  
  // Calculate consensus metrics
  const consensusData = calculateConsensusMetrics(wordSuggestions, participants.size);
  
  // Format previous clue options for prompt
  const previousCluePrompt = consensusInfo.previousClueOptions.length > 0 
    ? consensusInfo.previousClueOptions.map(pc => 
      `"${pc.clue}" (${pc.remainingGuesses} guesses left): ${pc.suggestedWords.join(', ')}`
    ).join('\n')
    : "None";
  
  // Format suggested word alternatives for prompt
  const formattedWordSuggestions = Array.from(wordSuggestions.entries())
    .sort((a, b) => {
      // Sort by net support (supporters - opposers)
      const netSupportA = a[1].supporters.length - a[1].opposers.length;
      const netSupportB = b[1].supporters.length - b[1].opposers.length;
      return netSupportB - netSupportA;
    })
    .map(([word, data]) => {
      const supportRatio = data.supporters.length / Math.max(1, data.opposers.length);
      const consensusLevel = 
        supportRatio >= 3 && data.supporters.length >= 2 ? "STRONG CONSENSUS" :
        supportRatio >= 2 && data.supporters.length >= 2 ? "MODERATE CONSENSUS" :
        data.supporters.length >= 1 ? "SOME SUPPORT" : "NO CLEAR SUPPORT";
      
      const avgConfidence = data.confidence / Math.max(1, data.supporters.length);
      
      const previousClueInfo = data.fromPreviousClue 
        ? ` (from previous clue "${data.sourceClue}")` 
        : "";
      
      const relatedWordsInfo = data.relatedWords.length > 0
        ? ` (related to: ${data.relatedWords.join(', ')})`
        : "";
      
      return `"${word}"${previousClueInfo}: ${consensusLevel}, supported by ${data.supporters.join(', ')}, opposed by ${data.opposers.join(', ')}, ${(avgConfidence * 100).toFixed(0)}% confidence, Risk: ${data.risk}${relatedWordsInfo}`;
    })
    .join('\n');
  
  // Find multi-word suggestions (agents suggesting multiple words)
  const agentMultiSuggestions = extractMultiWordSuggestions(teamDiscussion);
  const formattedMultiSuggestions = agentMultiSuggestions.length > 0
    ? agentMultiSuggestions.map(ms => `${ms.agent}: ${ms.words.join(', ')}`).join('\n')
    : "None";
  
  // Process conflict resolutions
  const conflictResolutionState = consensusInfo.hasUnresolvedConflicts
    ? "ACTIVE CONFLICTS NEED RESOLUTION. Help the team resolve conflicts between different word suggestions."
    : "No active conflicts in discussion.";
  
  // Analyze game state
  const currentClueGuesses = gameHistory.filter(entry => 
    entry.type === "guess" && 
    entry.relatedClue === clue.word &&
    entry.word // ensure word is defined
  );
  
  const guessesRemainingForClue = clue.number - guessesThisTurn;
  const availableWords = words.filter(w => !revealedCards.includes(w));
  
  // Game state assessment for strategic decisions
  const scoreGap = teamScore - opposingTeamScore;
  const timeStatus = timeRemainingInTurn < 15 ? "URGENT" : 
                     timeRemainingInTurn < 30 ? "LIMITED" : "SUFFICIENT";
  
  // Get recent clue history
  const recentClues = gameHistory
    .filter(h => h.type === 'clue')
    .slice(-5)
    .map(h => h.content);
  
  // Build adaptive prompt based on conversation round and game state
  let prompt;
  
  if (conversationRound === 1) {
    // First round: Initial analysis with memory awareness
    prompt = `You are playing Codenames as a ${team} team player with the role of "${participantRole}".
Your team received the clue: "${clue.word}" (${clue.number})

GAME CONTEXT:
- Score: ${team} ${teamScore} - ${team === 'red' ? 'blue' : 'red'} ${opposingTeamScore} (${scoreGap > 0 ? 'leading by '+scoreGap : scoreGap < 0 ? 'trailing by '+Math.abs(scoreGap) : 'tied'})
- Previous clues: ${recentClues.join(', ')}
- Available words: ${availableWords.join(', ')}
- Words revealed so far: ${revealedCards.join(', ')}
- Time remaining in turn: ${timeRemainingInTurn} seconds (${timeStatus})

ACTIVE CLUES FROM PREVIOUS TURNS (you can consider these too):
${previousCluePrompt}

This is the start of your team's discussion. As the first contributor, provide your initial analysis of the clue.
Consider:
1. What words on the board might connect to "${clue.word}"
2. Any risks or ambiguities in potential matches
3. Your confidence level in your suggestions
4. Strategic implications based on the game score
5. Whether any words from previous clues also match this new clue

CRITICAL REQUIREMENTS:
- YOU MUST SUGGEST AT LEAST 3-5 CANDIDATE WORDS - this is absolutely required
- RANK your suggestions by confidence and explain your reasoning for each
- Consider MULTIPLE DIMENSIONS of meaning for the clue word:
  * Different definitions or senses of the word
  * Category relationships (supersets, subsets)
  * Functional relationships (tools, actions, results)
  * Metaphorical relationships
  * Cultural or contextual relationships
- For each suggested word, explain WHY you think it matches and rate its:
  * Confidence (how likely it is to be correct)
  * Risk level (consequence of being wrong)
- Be CONVERSATIONAL and engage in thoughtful analysis
- Think like you're having a real discussion with teammates

You MUST make a decision about what action to take:
- "discuss": Continue discussing the clue with teammates (default for first round)
- "guess": Suggest making a specific guess right away if you're very confident
- "end_turn": Suggest ending the turn if you see no good options

DEEP THINKING GUIDELINES:
- Analyze each candidate word thoroughly, considering multiple interpretations
- Think about how the words might relate to each other and previous clues
- Consider both obvious and non-obvious connections
- Examine potential negative consequences of incorrect guesses
- Think through multiple steps ahead - what happens after each possible guess

Respond as a real team member would, with a detailed multi-word analysis.
Include JSON with your suggestions: {
  "message": "your conversational response",
  "confidence": number between 0-1,
  "suggestedWords": ["word1", "word2", "word3", "word4", ...], 
  "suggestedWord": "your most likely word match (first word in suggestedWords)",
  "risk": "High" or "Medium" or "Low",
  "action": "discuss" or "guess" or "end_turn",
  "reasoning": "brief explanation for your action choice"
}`;
  } else {
    // Subsequent rounds: Respond to ongoing discussion with memory and conflict resolution
    prompt = `You are playing Codenames as a ${team} team player with the role of "${participantRole}".
This is round ${conversationRound} of your team's discussion about the clue: "${clue.word}" (${clue.number})

GAME STATE:
- Score: ${team} ${teamScore} - ${team === 'red' ? 'blue' : 'red'} ${opposingTeamScore} (${scoreGap > 0 ? 'leading by'+scoreGap : scoreGap < 0 ? 'trailing by'+Math.abs(scoreGap) : 'tied'})
- Guesses made for this clue: ${currentClueGuesses.length}
- Guesses remaining for this clue: ${guessesRemainingForClue}
- Available words: ${availableWords.join(', ')}
- Words revealed so far: ${revealedCards.join(', ')}
- Time remaining in turn: ${timeRemainingInTurn} seconds (${timeStatus})

CONSENSUS ASSESSMENT:
${consensusData.consensusWord
  ? `${consensusData.consensusLevel} CONSENSUS has emerged around "${consensusData.consensusWord}" with ${consensusData.supportersCount} supporters and ${consensusData.opposersCount} opposers.`
  : "NO CLEAR CONSENSUS has emerged yet."}
${conflictResolutionState}

PREVIOUS CLUES STILL ACTIVE:
${previousCluePrompt}

MULTI-WORD SUGGESTIONS FROM TEAM MEMBERS:
${formattedMultiSuggestions}

TEAM DISCUSSION HISTORY:
${fullDiscussion}

WORD CANDIDATES WITH CURRENT SUPPORT:
${formattedWordSuggestions || "No specific words suggested yet"}

IMPORTANT GUIDANCE FOR YOUR TURN:
${conversationRound >= 3 && consensusInfo.hasUnresolvedConflicts
  ? "FOCUS ON RESOLVING CONFLICTS. Help the team decide between competing suggestions."
  : consensusData.consensusWord && consensusData.consensusLevel === "High"
  ? "A STRONG CONSENSUS HAS EMERGED. Consider whether to support the consensus or raise concerns."
  : consensusInfo.previousClueOptions.length > 0 && consensusData.consensusLevel !== "High"
  ? "CONSIDER PREVIOUS CLUES as alternatives if current clue is difficult."
  : "HELP BUILD CONSENSUS by addressing specific suggestions or offering your own."}

${conversationRound >= 2
  ? "DIRECTLY RESPOND to other team members' suggestions by name. State whether you AGREE or DISAGREE with specific suggestions and WHY."
  : "Provide your initial assessment of possible words."}

You MUST make a decision about what action to take:
- "discuss": Continue discussing the clue if more input is needed (default option)
- "guess": Suggest making a specific guess if you're confident about a word
- "end_turn": Suggest ending the turn if the team is stuck, the risk is too high, or time is short

${timeRemainingInTurn < 20 ? "TIME IS RUNNING OUT! Be decisive about whether to guess or end the turn." : ""}
${conversationRound > 4 ? "DISCUSSION HAS GONE ON FOR MULTIPLE ROUNDS. Consider making a decision soon." : ""}

IMPORTANT REMINDERS:
- You MUST respond in a conversational, human-like way - like a real team member
- You MUST suggest MULTIPLE WORDS (at least 2-3) with your detailed reasoning for each
- Clearly explain your opinion on each word that's been discussed by the team
- RANK your suggested words by confidence and explain your reasoning
- If you disagree with another team member, explain exactly WHY with specific reasoning
- Consider deeper semantic connections and alternative interpretations of words
- Think through the consequences of different guesses strategically
- Be thoughtful about resolving conflicts between competing suggestions
- Don't get stuck - if discussion isn't progressing, suggest making a decision
- Always give specific reasons for your confidence levels

Respond conversationally as a team member would, addressing specific points raised by others.
Include JSON with your analysis: {
  "message": "your conversational response",
  "confidence": number between 0-1,
  "suggestedWords": ["word1", "word2", "word3", ...],
  "suggestedWord": "your preferred word suggestion (should be the first item in suggestedWords)",
  "risk": "High" or "Medium" or "Low",
  "action": "discuss" or "guess" or "end_turn",
  "reasoning": "detailed explanation for your action choice"
}`;
  }

  console.log(`🎮 ${model} thinking about ${team} team's clue: "${clue.word}" (round ${conversationRound})`);
  
  try {
    let response;
    switch (model) {
      case "gpt-4o":
        response = await getOpenAIEnhancedDiscussion(prompt);
        break;
      case "claude-sonnet-4-5-20250929":
        response = await getAnthropicEnhancedDiscussion(prompt);
        break;
      case "grok-4-fast-reasoning":
        response = await getXAIEnhancedDiscussion(prompt);
        break;
      case "gemini-1.5-pro":
        response = await getGeminiEnhancedDiscussion(prompt);
        break;
      default:
        throw new Error(`Invalid AI model: ${model}`);
    }
    
    // Log multi-word suggestions if present
    if (response.suggestedWords && response.suggestedWords.length > 1) {
      console.log(`🔤 ${model} suggesting multiple words: ${response.suggestedWords.join(', ')}`);
    }
    
    // If action is 'guess' but no word specified, default to 'discuss'
    if (response.action === 'guess' && !response.suggestedWord && 
        (!response.suggestedWords || response.suggestedWords.length === 0)) {
      console.log(`⚠️ ${model} wanted to guess but didn't specify a word. Defaulting to 'discuss'`);
      response.action = 'discuss';
      response.reasoning = "Need to decide which word to guess first.";
    }
    
    // Ensure we always prioritize suggestedWords if available
    if (!response.suggestedWords && response.suggestedWord) {
      response.suggestedWords = [response.suggestedWord];
    }
    
    // IMPORTANT CHANGE: We always want to keep suggestedWords, even if only one word is suggested
  // Initialize suggestedWords if needed
  if (!response.suggestedWords) {
    response.suggestedWords = response.suggestedWord ? [response.suggestedWord] : [];
  } else if (response.suggestedWord && !response.suggestedWords.includes(response.suggestedWord)) {
    // Ensure the primary suggestedWord is also in the suggestedWords array
    response.suggestedWords.unshift(response.suggestedWord);
  }
  
  // If no primary suggestion but we have alternatives, pick the first one as primary
  if (!response.suggestedWord && response.suggestedWords && response.suggestedWords.length > 0) {
    response.suggestedWord = response.suggestedWords[0];
  }
  
  // Update turn results in the game memory system if action is 'guess'
  if (response.action === 'guess' && response.suggestedWord && gameId) {
    // We don't actually update memory here, just log the intent
    console.log(`🎯 ${model} intends to guess "${response.suggestedWord}" for team ${team} (game ${gameId})`);
    if (response.suggestedWords && response.suggestedWords.length > 1) {
      console.log(`🎯 ${model} also considered: ${response.suggestedWords.slice(1).join(', ')}`);
    }
  }
  
  // Create a consistent return value with word-specific confidences
  const result = {
    message: response.message,
    suggestedWords: response.suggestedWords || [],
    // Calculate confidences for each suggested word
    confidences: response.suggestedWords 
      ? response.suggestedWords.map((word, idx) => {
          // If explicitly provided word confidences, use those
          if (response.wordConfidences && response.wordConfidences[idx] !== undefined) {
            return response.wordConfidences[idx];
          }
          // Otherwise decrease confidence by 15% for each position after the first
          return Math.max(0.2, response.confidence * (1 - idx * 0.15));
        }) 
      : [],
    risk: response.risk || "Medium",
    action: response.action || "discuss",
    reasoning: response.reasoning || "Continuing team discussion.",
    // Track time information for the UI
    timeInfo: {
      turnStartTime: currentTurnStartTime ? currentTurnStartTime.getTime() : Date.now(),
      turnTimeLimit: turnTimeLimit || 60,
      remainingTime: timeRemainingInTurn || 60
    }
  };
  
  // Ensure we always have at least one confidence value
  if (result.confidences.length === 0 && result.suggestedWords.length > 0) {
    result.confidences = [response.confidence || 0.5];
  } else if (result.confidences.length === 0) {
    result.confidences = [0.5]; // Default confidence
  }
    
    return result;
  } catch (error) {
    console.error(`Error in discussAndVote for ${model}:`, error);
    // Provide safe fallback response
    return {
      message: "I'm having trouble processing this clue. Let's discuss it further.",
      confidence: 0.3,
      suggestedWords: [],
      risk: "High",
      action: "discuss",
      reasoning: "Error in processing - defaulting to continued discussion."
    };
  }
}

// Helper functions for enhanced discussion analysis

// Extract multi-word suggestions from discussion
function extractMultiWordSuggestions(teamDiscussion: TeamDiscussionEntry[]): { agent: string, words: string[] }[] {
  const result: { agent: string, words: string[] }[] = [];
  
  // Group discussion entries by agent
  const agentEntries = new Map<string, TeamDiscussionEntry[]>();
  
  teamDiscussion.forEach(entry => {
    if (!agentEntries.has(entry.player)) {
      agentEntries.set(entry.player, []);
    }
    agentEntries.get(entry.player)!.push(entry);
  });
  
  // For each agent, find messages that contain multiple word suggestions
  for (const [agent, entries] of agentEntries.entries()) {
    // Look for entries with suggestedWord, and check if multiple suggestions appear in one message
    const wordsByMessage = new Map<string, string[]>();
    
    entries.forEach(entry => {
      if (entry.suggestedWord) {
        const msgId = entry.message;
        if (!wordsByMessage.has(msgId)) {
          wordsByMessage.set(msgId, []);
        }
        if (!wordsByMessage.get(msgId)!.includes(entry.suggestedWord)) {
          wordsByMessage.get(msgId)!.push(entry.suggestedWord);
        }
      }
    });
    
    // Find messages with multiple suggested words
    for (const [_, words] of wordsByMessage.entries()) {
      if (words.length > 1) {
        result.push({ agent, words });
        break; // Only add each agent once
      }
    }
    
    // Also look for explicit multi-word suggestions in message text
    // Patterns like "I suggest A, B, and C" or "I'm thinking about X and Y"
    for (const entry of entries) {
      const message = entry.message.toLowerCase();
      if (message.includes(" and ") || message.includes(", ") || message.includes(" or ")) {
        const suggestedWords = new Set<string>();
        
        // Add the explicit suggestedWord if it exists
        if (entry.suggestedWord) {
          suggestedWords.add(entry.suggestedWord);
        }
        
        // Look for words from the available board that are mentioned with suggestion phrases
        const suggestionPatterns = [
          "suggest", "recommend", "consider", "think", 
          "option", "possibility", "candidate", "potential",
          "good match", "connection", "related"
        ];
        
        if (suggestionPatterns.some(pattern => message.includes(pattern))) {
          // This message has suggestion language, extract words
          // (In a real implementation, this would match against available board words)
          // For this simplified version, we'll just look for capitalized words
          const capitalizedWords = message.match(/\b[A-Z][A-Za-z]*\b/g);
          if (capitalizedWords && capitalizedWords.length > 1) {
            capitalizedWords.forEach(word => suggestedWords.add(word));
          }
        }
        
        if (suggestedWords.size > 1) {
          result.push({ 
            agent, 
            words: Array.from(suggestedWords)
          });
          break; // Only add each agent once
        }
      }
    }
  }
  
  return result;
}

// Analyze discussion patterns
function analyzeDiscussionPatterns(teamDiscussion: TeamDiscussionEntry[]): {
  disagreements: { 
    agent1: string; 
    agent2: string; 
    word1?: string; 
    word2?: string; 
    resolved: boolean;
  }[];
  mentionedPreviousClues: string[];
  wordSentiment: Map<string, "positive" | "negative" | "neutral">;
} {
  const disagreements: { 
    agent1: string; 
    agent2: string; 
    word1?: string; 
    word2?: string; 
    resolved: boolean;
  }[] = [];
  
  const mentionedPreviousClues: string[] = [];
  const wordSentiment = new Map<string, "positive" | "negative" | "neutral">();
  
  // First, collect all agent suggestions
  const agentSuggestions = new Map<string, { word: string; confidence: number; message: string; }[]>();
  
  teamDiscussion.forEach(entry => {
    if (entry.suggestedWord) {
      if (!agentSuggestions.has(entry.player)) {
        agentSuggestions.set(entry.player, []);
      }
      
      agentSuggestions.get(entry.player)!.push({
        word: entry.suggestedWord,
        confidence: entry.confidence,
        message: entry.message
      });
      
      // Track sentiment for this word
      if (!wordSentiment.has(entry.suggestedWord)) {
        if (entry.confidence > 0.7) {
          wordSentiment.set(entry.suggestedWord, "positive");
        } else if (entry.confidence < 0.3) {
          wordSentiment.set(entry.suggestedWord, "negative");
        } else {
          wordSentiment.set(entry.suggestedWord, "neutral");
        }
      } else if (entry.confidence > 0.7 && wordSentiment.get(entry.suggestedWord) !== "positive") {
        wordSentiment.set(entry.suggestedWord, "positive");
      } else if (entry.confidence < 0.3 && wordSentiment.get(entry.suggestedWord) === "positive") {
        // If previously positive but now negative, that's a disagreement
        wordSentiment.set(entry.suggestedWord, "neutral"); // Mark as contested
      }
    }
    
    // Look for mentions of previous clues
    const messageLower = entry.message.toLowerCase();
    const previousCluePatterns = [
      "previous clue", "earlier clue", "last clue", "before", 
      "last round", "last turn", "remember", "earlier"
    ];
    
    if (previousCluePatterns.some(pattern => messageLower.includes(pattern))) {
      // Try to extract the mentioned clue
      const clueMatches = entry.message.match(/["']([^"']+)["']/g);
      if (clueMatches) {
        clueMatches.forEach(match => {
          const cleanedClue = match.replace(/["']/g, '').trim();
          if (cleanedClue.length > 0 && !mentionedPreviousClues.includes(cleanedClue)) {
            mentionedPreviousClues.push(cleanedClue);
          }
        });
      }
    }
  });
  
  // Look for explicit disagreements in messages
  for (let i = 0; i < teamDiscussion.length; i++) {
    const entry = teamDiscussion[i];
    const msgLower = entry.message.toLowerCase();
    
    // Check for explicit disagreement language
    const disagreementPatterns = [
      "disagree", "don't think", "not sure", "too risky", 
      "instead of", "rather than", "better than", "prefer",
      "no, ", "not ", "unlike", "contrary", "dispute"
    ];
    
    if (disagreementPatterns.some(pattern => msgLower.includes(pattern))) {
      // This message expresses disagreement - look for whom they're disagreeing with
      for (let j = 0; j < i; j++) {
        const prevEntry = teamDiscussion[j];
        
        // Only consider disagreements between different agents
        if (prevEntry.player === entry.player) continue;
        
        // If the current message mentions the previous suggestion, it's likely a disagreement
        if (prevEntry.suggestedWord && msgLower.includes(prevEntry.suggestedWord.toLowerCase())) {
          disagreements.push({
            agent1: prevEntry.player,
            agent2: entry.player,
            word1: prevEntry.suggestedWord,
            word2: entry.suggestedWord,
            resolved: false // Initially unresolved
          });
        }
      }
    }
  }
  
  // Process disagreements to determine if they've been resolved
  disagreements.forEach(disagreement => {
    // Only consider resolvable if we know both words
    if (!disagreement.word1 || !disagreement.word2) return;
    
    // Count the support for each word across all messages
    let word1Support = 0;
    let word2Support = 0;
    
    teamDiscussion.forEach(entry => {
      if (entry.suggestedWord === disagreement.word1 && entry.confidence > 0.5) {
        word1Support++;
      } else if (entry.suggestedWord === disagreement.word2 && entry.confidence > 0.5) {
        word2Support++;
      }
    });
    
    // A conflict is resolved if one word has significantly more support
    if (Math.abs(word1Support - word2Support) >= 2) {
      disagreement.resolved = true;
    }
  });
  
  return {
    disagreements,
    mentionedPreviousClues,
    wordSentiment
  };
}

// Calculate consensus metrics from word suggestions
function calculateConsensusMetrics(
  wordSuggestions: Map<string, {
    mentions: number;
    supporters: string[];
    opposers: string[];
    confidence: number;
    risk: RiskLevel;
    fromPreviousClue: boolean;
    sourceClue?: string;
    relatedWords: string[];
  }>,
  totalParticipants: number
): {
  consensusWord: string | null;
  consensusLevel: "High" | "Medium" | "Low" | "None";
  supportersCount: number;
  opposersCount: number;
  riskLevel: RiskLevel;
} {
  if (wordSuggestions.size === 0) {
    return {
      consensusWord: null,
      consensusLevel: "None",
      supportersCount: 0,
      opposersCount: 0,
      riskLevel: "High"
    };
  }
  
  // Calculate support metrics for each word
  const wordMetrics = Array.from(wordSuggestions.entries()).map(([word, data]) => {
    const supportRatio = data.supporters.length / Math.max(1, data.opposers.length);
    const supportPercentage = data.supporters.length / totalParticipants;
    const netSupport = data.supporters.length - data.opposers.length;
    
    return {
      word,
      supporters: data.supporters.length,
      opposers: data.opposers.length,
      supportRatio,
      supportPercentage,
      netSupport,
      risk: data.risk,
      avgConfidence: data.confidence / Math.max(1, data.supporters.length)
    };
  });
  
  // Sort by netSupport first, then supportRatio, then avgConfidence
  wordMetrics.sort((a, b) => {
    if (b.netSupport !== a.netSupport) return b.netSupport - a.netSupport;
    if (b.supportRatio !== a.supportRatio) return b.supportRatio - a.supportRatio;
    return b.avgConfidence - a.avgConfidence;
  });
  
  if (wordMetrics.length === 0) {
    return {
      consensusWord: null,
      consensusLevel: "None",
      supportersCount: 0,
      opposersCount: 0,
      riskLevel: "High"
    };
  }
  
  const topWord = wordMetrics[0];
  
  // Determine consensus level
  let consensusLevel: "High" | "Medium" | "Low" | "None";
  
  if (topWord.supporters >= 3 || (topWord.supporters >= 2 && topWord.supportPercentage >= 0.7)) {
    consensusLevel = "High";
  } else if (topWord.supporters >= 2 || (topWord.supporters >= 1 && topWord.supportPercentage >= 0.5)) {
    consensusLevel = "Medium";
  } else if (topWord.supporters >= 1) {
    consensusLevel = "Low";
  } else {
    consensusLevel = "None";
  }
  
  return {
    consensusWord: topWord.word,
    consensusLevel,
    supportersCount: topWord.supporters,
    opposersCount: topWord.opposers,
    riskLevel: topWord.risk
  };
}

// Implementation for enhanced discussion functions that handle multi-word suggestions
async function getOpenAIEnhancedDiscussion(prompt: string): Promise<{ 
  message: string; 
  confidence: number; 
  suggestedWord?: string;
  suggestedWords?: string[];
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
}> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return validateEnhancedDiscussionResponse(JSON.parse(content));
}

async function getAnthropicEnhancedDiscussion(prompt: string): Promise<{ 
  message: string; 
  confidence: number; 
  suggestedWord?: string;
  suggestedWords?: string[];
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
}> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'I am a Codenames AI assistant that can suggest multiple words and help resolve conflicts.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        message: "I encountered an error processing the response. Let's continue our discussion.",
        confidence: 0.5,
        action: "discuss"
      };
    }

    return validateEnhancedDiscussionResponse(JSON.parse(jsonMatch[0]));
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    return {
      message: "I encountered an error processing the response. Let's proceed with caution.",
      confidence: 0.5,
      action: "discuss"
    };
  }
}

async function getXAIEnhancedDiscussion(prompt: string): Promise<{ 
  message: string; 
  confidence: number; 
  suggestedWord?: string;
  suggestedWords?: string[];
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
}> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return validateEnhancedDiscussionResponse(JSON.parse(content));
}

async function getGeminiEnhancedDiscussion(prompt: string): Promise<{ 
  message: string; 
  confidence: number; 
  suggestedWord?: string;
  suggestedWords?: string[];
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
}> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ 
          text: `${prompt}\n\nRespond ONLY with a JSON object that includes message, confidence, and may include suggestedWord, suggestedWords (array), risk, action, and reasoning.`
        }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      return validateEnhancedDiscussionResponse(parsed);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        return validateEnhancedDiscussionResponse(extracted);
      }
      throw new Error("Failed to parse Gemini discussion response");
    }
  } catch (error) {
    console.error("Error in Gemini discussion:", error);
    return {
      message: "Failed to get response from Gemini",
      confidence: 0.5,
      action: "discuss"
    };
  }
}

// Helper to validate and normalize enhanced discussion responses
function validateEnhancedDiscussionResponse(response: any): { 
  message: string; 
  confidence: number; 
  suggestedWord?: string;
  suggestedWords?: string[];
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
} {
  // Create a new response object to ensure consistent structure
  const validatedResponse: {
    message: string;
    confidence: number;
    suggestedWord?: string;
    suggestedWords?: string[];
    risk: RiskLevel;
    action: "discuss" | "guess" | "end_turn";
    reasoning: string;
  } = {
    message: "Let's continue our discussion of the clue.",
    confidence: 0.5,
    suggestedWords: [],
    risk: "Medium" as RiskLevel,
    action: "discuss",
    reasoning: "More discussion needed to reach consensus."
  };
  
  // Copy values from response, with validation
  if (response.message && typeof response.message === "string") {
    validatedResponse.message = response.message;
  }
  
  if (typeof response.confidence === "number" && response.confidence >= 0 && response.confidence <= 1) {
    validatedResponse.confidence = response.confidence;
  }
  
  // Handle suggested words (array)
  if (response.suggestedWords && Array.isArray(response.suggestedWords)) {
    // Filter out any non-string entries
    validatedResponse.suggestedWords = response.suggestedWords.filter(w => typeof w === "string");
  }
  
  // Handle single suggested word
  if (response.suggestedWord && typeof response.suggestedWord === "string") {
    validatedResponse.suggestedWord = response.suggestedWord;
    
    // If no suggested words array, create one from suggestedWord
    if (!validatedResponse.suggestedWords || validatedResponse.suggestedWords.length === 0) {
      validatedResponse.suggestedWords = [response.suggestedWord];
    }
  } else if (validatedResponse.suggestedWords && validatedResponse.suggestedWords.length > 0) {
    // If we have suggested words but no primary one, use the first
    validatedResponse.suggestedWord = validatedResponse.suggestedWords[0];
  }
  
  if (response.risk && ["High", "Medium", "Low"].includes(response.risk)) {
    validatedResponse.risk = response.risk as RiskLevel;
  }
  
  if (response.action && ["discuss", "guess", "end_turn"].includes(response.action)) {
    validatedResponse.action = response.action as "discuss" | "guess" | "end_turn";
  }
  
  // Ensure consistency between action and suggestedWord/suggestedWords
  if (validatedResponse.action === "guess") {
    if (!validatedResponse.suggestedWord) {
      validatedResponse.action = "discuss";
    }
  }
  
  if (response.reasoning && typeof response.reasoning === "string") {
    validatedResponse.reasoning = response.reasoning;
  } else {
    validatedResponse.reasoning = validatedResponse.action === "discuss" 
      ? "More discussion needed to reach consensus." 
      : validatedResponse.action === "guess" && validatedResponse.suggestedWord
      ? `Confident about guessing "${validatedResponse.suggestedWord}".`
      : "Risk is too high or no clear consensus has emerged.";
  }
  
  return validatedResponse;
}

// Helper implementations for AI discussion with action
async function getOpenAIDiscussionWithAction(prompt: string): Promise<{ 
  message: string; 
  confidence: number; 
  suggestedWord?: string; 
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
}> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return validateDiscussionResponse(JSON.parse(content));
}

async function getAnthropicDiscussionWithAction(prompt: string): Promise<{ 
  message: string; 
  confidence: number; 
  suggestedWord?: string; 
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
}> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'I am a Codenames AI assistant that will discuss the clue and suggest actions in valid JSON format.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        message: "I encountered an error processing the response. Let's continue our discussion.",
        confidence: 0.5,
        action: "discuss"
      };
    }

    return validateDiscussionResponse(JSON.parse(jsonMatch[0]));
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    return {
      message: "I encountered an error processing the response. Let's proceed with caution.",
      confidence: 0.5,
      action: "discuss"
    };
  }
}

async function getXAIDiscussionWithAction(prompt: string): Promise<{ message: string; confidence: number; suggestedWord?: string; risk?: RiskLevel; action?: "discuss" | "guess" | "end_turn"; reasoning?: string }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return validateDiscussionResponse(JSON.parse(content));
}

async function getGeminiDiscussionWithAction(prompt: string): Promise<{ message: string; confidence: number; suggestedWord?: string; risk?: RiskLevel; action?: "discuss" | "guess" | "end_turn"; reasoning?: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ 
          text: `${prompt}\n\nRespond ONLY with a JSON object in this format:
{
  "message": "your conversational response",
  "confidence": number between 0-1,
  "suggestedWord": "your suggested word if any",
  "risk": "High" or "Medium" or "Low",
  "action": "discuss" or "guess" or "end_turn",
  "reasoning": "brief explanation for your action choice"
}`
        }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      return validateDiscussionResponse(parsed);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        return validateDiscussionResponse(extracted);
      }
      throw new Error("Failed to parse Gemini discussion action response");
    }
  } catch (error) {
    console.error("Error in Gemini discussion action:", error);
    return {
      message: "Failed to get response from Gemini",
      confidence: 0.5,
      action: "discuss"
    };
  }
}

// Helper to validate and normalize discussion responses
function validateDiscussionResponse(response: any): { 
  message: string; 
  confidence: number; 
  suggestedWord?: string; 
  risk?: RiskLevel;
  action?: "discuss" | "guess" | "end_turn";
  reasoning?: string;
} {
  if (!response.message || typeof response.message !== "string") {
    response.message = "Let's continue our discussion of the clue.";
  }
  
  if (typeof response.confidence !== "number" || response.confidence < 0 || response.confidence > 1) {
    response.confidence = 0.5;
  }
  
  if (response.suggestedWord && typeof response.suggestedWord !== "string") {
    delete response.suggestedWord;
  }
  
  if (!response.risk || !["High", "Medium", "Low"].includes(response.risk)) {
    response.risk = "Medium";
  }
  
  if (!response.action || !["discuss", "guess", "end_turn"].includes(response.action)) {
    response.action = "discuss";
  }
  
  // Ensure consistency between action and suggestedWord
  if (response.action === "guess" && !response.suggestedWord) {
    response.action = "discuss";
  }
  
  if (!response.reasoning || typeof response.reasoning !== "string") {
    response.reasoning = response.action === "discuss" 
      ? "More discussion needed to reach consensus." 
      : response.action === "guess"
      ? `Confident about guessing "${response.suggestedWord}".`
      : "Risk is too high or no clear consensus has emerged.";
  }
  
  return response;
}

// Helper to format discussion messages more naturally including voting information
export function formatDiscussionMessage(
  model: AIModel,
  message: string,
  confidence: number,  // Use the highest confidence as a general indicator
  suggestedWord: string | null,  // Not used anymore but kept for compatibility
  suggestedWords?: string[]
): string {
  const displayName = getModelDisplayName(model);
  let formattedMsg = message;

  // Handle word suggestions with ranked preferences
  if (suggestedWords && suggestedWords.length > 0) {
    const confidenceText = confidence > 0.7 ? "strongly suggest" : 
                           confidence > 0.5 ? "suggest" : "am considering";
    
    // Format as a ranked list to show preference order
    const rankedList = suggestedWords.map((word, index) => {
      // Use estimated confidence based on position
      const wordConfidence = Math.max(0.2, confidence - (index * 0.1)).toFixed(1);
      
      if (index === 0) {
        return `${word} (first choice, ${wordConfidence})`;
      } else if (index === 1) {
        return `${word} (second choice, ${wordConfidence})`;
      } else if (index === 2) {
        return `${word} (third choice, ${wordConfidence})`;
      } else {
        return `${word} (${wordConfidence})`;
      }
    });
    
    // Different formatting based on number of suggestions
    if (suggestedWords.length > 1) {
      // For multiple words, don't modify the message - we'll display this in the UI
      // The suggested words and confidences will be shown in a separate UI element
    } else {
      // For a single word with strong confidence, make it more explicit
      const word = suggestedWords[0];
      if (confidence > 0.8) {
        formattedMsg += ` I VOTE for "${word}" (${(confidence * 100).toFixed(0)}% confident)`;
      } else if (confidence > 0.6) {
        formattedMsg += ` I suggest "${word}" (${(confidence * 100).toFixed(0)}% confident)`;
      } else if (confidence > 0.4) {
        formattedMsg += ` I'm considering "${word}" (${(confidence * 100).toFixed(0)}% confident)`;
      } else {
        formattedMsg += ` Maybe "${word}"? (uncertain, ${(confidence * 100).toFixed(0)}% confident)`;
      }
    }
  }

  // Add past guess memory references if message contains "previous" or "earlier"
  if (message.toLowerCase().includes("previous") || message.toLowerCase().includes("earlier") || 
      message.toLowerCase().includes("remember") || message.toLowerCase().includes("last turn")) {
    formattedMsg += " [Recalling past clues]";
  }
  
  // For meta decisions, make the request for votes clearer
  if (message.toLowerCase().includes("should we continue") || 
      message.toLowerCase().includes("should we end") ||
      message.toLowerCase().includes("end our turn") ||
      message.toLowerCase().includes("keep guessing")) {
    formattedMsg += " [VOTE REQUIRED]";
  }

  return formattedMsg;
}

// Analyzes the discussion to calculate consensus metrics
export function assessConsensus(
  teamDiscussion: TeamDiscussionEntry[]
): { 
  consensusWord: string | null; 
  consensusLevel: "High" | "Medium" | "Low" | "None";
  participationComplete: boolean;
  riskLevel: "High" | "Medium" | "Low";
  candidateWords: { word: string, votes: number, avgConfidence: number, supporters: string[] }[]
} {
  // Extract all models that have participated
  const participants = new Set<string>();
  teamDiscussion.forEach(entry => participants.add(entry.player));
  
  // Track word suggestions and their supporters
  const wordMap = new Map<string, { 
    votes: number, 
    totalConfidence: number,
    supporters: Set<string>
  }>();
  
  // Process each discussion entry
  teamDiscussion.forEach(entry => {
    if (entry.suggestedWord) {
      const word = entry.suggestedWord;
      const data = wordMap.get(word) || { votes: 0, totalConfidence: 0, supporters: new Set<string>() };
      data.votes += 1;
      data.totalConfidence += entry.confidence;
      data.supporters.add(entry.player);
      wordMap.set(word, data);
    }
  });
  
  // Convert to array and sort by number of supporters then votes
  const candidateWords = Array.from(wordMap.entries())
    .map(([word, data]) => ({
      word,
      votes: data.votes,
      avgConfidence: data.totalConfidence / data.votes,
      supporters: Array.from(data.supporters)
    }))
    .sort((a, b) => {
      // First by number of unique supporters
      if (b.supporters.length !== a.supporters.length) {
        return b.supporters.length - a.supporters.length;
      }
      // Then by total votes
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }
      // Finally by average confidence
      return b.avgConfidence - a.avgConfidence;
    });
  
  // Determine if we have a consensus word
  const consensusWord = candidateWords.length > 0 ? candidateWords[0].word : null;
  
  // Calculate participation completeness (did all models contribute?)
  const participationComplete = participants.size >= 2;
  
  // Determine consensus level
  let consensusLevel: "High" | "Medium" | "Low" | "None" = "None";
  
  if (consensusWord && candidateWords[0].supporters.length > 0) {
    const supporterPercentage = candidateWords[0].supporters.length / participants.size;
    const avgConfidence = candidateWords[0].avgConfidence;
    
    if (supporterPercentage >= 0.75 && avgConfidence >= 0.7) {
      consensusLevel = "High";
    } else if (supporterPercentage >= 0.5 && avgConfidence >= 0.5) {
      consensusLevel = "Medium";
    } else if (supporterPercentage > 0 || avgConfidence > 0.3) {
      consensusLevel = "Low";
    }
  }
  
  // Determine risk level
  let riskLevel: "High" | "Medium" | "Low" = "High";
  
  if (consensusWord && candidateWords[0].avgConfidence >= 0.8) {
    riskLevel = "Low";
  } else if (consensusWord && candidateWords[0].avgConfidence >= 0.5) {
    riskLevel = "Medium";
  }
  
  return {
    consensusWord,
    consensusLevel,
    participationComplete,
    riskLevel,
    candidateWords
  };
}

// New function for Team Voting Decision about continuing or ending turn
export async function getMetaDecision(
  model: AIModel,
  team: "red" | "blue",
  currentClue: { word: string; number: number },
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  availableWords: string[],
  revealedCards: string[],
  guessesThisTurn: number,
  gameScore: { red: number; blue: number },
  gameId: number = 1
): Promise<{ 
  action: "continue" | "end_turn"; 
  reasoning: string; 
  confidence: number;
}> {
  // Format the team discussion in a readable way
  const discussionText = teamDiscussion
    .map(d => {
      let wordText = "";
      if (d.suggestedWord) {
        wordText = ` [Suggests: ${d.suggestedWord}]`;
      } else if (d.suggestedWords && d.suggestedWords.length > 0) {
        wordText = ` [Suggests: ${d.suggestedWords.join(", ")}]`;
      }
      return `${d.player}: ${d.message}${wordText}`;
    })
    .join('\n');
  
  // Get recent game history to analyze patterns
  const recentHistory = gameHistory
    .slice(-20) // Look at the most recent history entries
    .filter(entry => entry.turn === team); // Only focus on this team's history
  
  // Get correct and incorrect guesses for the current clue
  const correctGuesses = recentHistory
    .filter(entry => 
      entry.type === "guess" && 
      entry.relatedClue === currentClue.word && 
      entry.result === "correct"
    )
    .map(entry => entry.word);
  
  const incorrectGuesses = recentHistory
    .filter(entry => 
      entry.type === "guess" && 
      entry.relatedClue === currentClue.word && 
      entry.result !== "correct" && 
      entry.result !== "pending"
    )
    .map(entry => entry.word);
  
  // Get current team score and remaining words to win
  const currentTeamScore = team === "red" ? gameScore.red : gameScore.blue;
  const opposingTeamScore = team === "red" ? gameScore.blue : gameScore.red;
  const wordsToWin = 9 - currentTeamScore; // Most games have 9 words per team

  // Get candidate words from discussion
  const candidateWords = new Map<string, {
    mentions: number,
    confidence: number,
    supporters: string[],
    opposers: string[]
  }>();

  // Process all suggested words from discussion
  teamDiscussion.forEach(entry => {
    // Handle single word suggestion
    if (entry.suggestedWord && !revealedCards.includes(entry.suggestedWord)) {
      if (!candidateWords.has(entry.suggestedWord)) {
        candidateWords.set(entry.suggestedWord, {
          mentions: 0,
          confidence: 0,
          supporters: [],
          opposers: []
        });
      }
      
      const data = candidateWords.get(entry.suggestedWord)!;
      data.mentions++;
      
      if (entry.confidence > 0.5) {
        if (!data.supporters.includes(entry.player)) {
          data.supporters.push(entry.player);
          data.confidence += entry.confidence;
        }
      } else if (entry.confidence < 0.3) {
        if (!data.opposers.includes(entry.player)) {
          data.opposers.push(entry.player);
        }
      }
    }
    
    // Handle multiple word suggestions
    if (entry.suggestedWords && entry.suggestedWords.length > 0) {
      entry.suggestedWords.forEach((word, idx) => {
        if (revealedCards.includes(word)) return;
        
        if (!candidateWords.has(word)) {
          candidateWords.set(word, {
            mentions: 0,
            confidence: 0,
            supporters: [],
            opposers: []
          });
        }
        
        const data = candidateWords.get(word)!;
        data.mentions++;
        
        // If confidences array exists, use the specific confidence for this word
        const wordConfidence = entry.confidences && entry.confidences[idx] !== undefined
          ? entry.confidences[idx]
          : Math.max(0.3, (entry.confidence || 0.5) * (1 - idx * 0.15)); // Decrease confidence for later words
        
        if (wordConfidence > 0.5) {
          if (!data.supporters.includes(entry.player)) {
            data.supporters.push(entry.player);
            data.confidence += wordConfidence;
          }
        } else if (wordConfidence < 0.3) {
          if (!data.opposers.includes(entry.player)) {
            data.opposers.push(entry.player);
          }
        }
      });
    }
  });

  // Format candidate words for the prompt
  const candidateWordsList = Array.from(candidateWords.entries())
    .sort((a, b) => {
      // First by support ratio (supporters - opposers)
      const supportRatioA = a[1].supporters.length - a[1].opposers.length;
      const supportRatioB = b[1].supporters.length - b[1].opposers.length;
      
      if (supportRatioB !== supportRatioA) {
        return supportRatioB - supportRatioA;
      }
      
      // Then by average confidence
      const avgConfidenceA = a[1].confidence / Math.max(1, a[1].supporters.length);
      const avgConfidenceB = b[1].confidence / Math.max(1, b[1].supporters.length);
      
      return avgConfidenceB - avgConfidenceA;
    })
    .map(([word, data]) => {
      const avgConfidence = data.confidence / Math.max(1, data.supporters.length);
      return `"${word}": mentioned ${data.mentions} times, supported by ${data.supporters.join(", ")} (${data.supporters.length}), opposed by ${data.opposers.join(", ")} (${data.opposers.length}), avg confidence: ${(avgConfidence * 100).toFixed(0)}%`;
    })
    .join('\n');

  // Generate a strategic assessment based on game state
  const hasStrongWord = Array.from(candidateWords.entries()).some(([_, data]) => {
    const avgConfidence = data.confidence / Math.max(1, data.supporters.length);
    return data.supporters.length > 1 && avgConfidence > 0.7;
  });

  // Create assessments of game situation and risk
  const gameState = currentTeamScore > opposingTeamScore ? "leading" : 
                    currentTeamScore < opposingTeamScore ? "trailing" : "tied";
  
  const scoreDifference = Math.abs(currentTeamScore - opposingTeamScore);
  const gamePhase = wordsToWin <= 2 ? "endgame" : 
                   wordsToWin <= 5 ? "midgame" : "earlygame";
  
  const riskAssessment = gameState === "leading" ? "Conservative play is advised" :
                        gameState === "trailing" && scoreDifference > 1 ? "Higher risk is justified" :
                        "Balanced risk approach recommended";

  // Create a comprehensive prompt for the Team Voting Decision
  const prompt = `You are playing Codenames as a ${team} team player with the role of ${model}. You need to make a strategic Team Voting Decision on whether to continue guessing or end your turn.

GAME STATE:
- Current clue: "${currentClue.word}" (${currentClue.number})
- Guesses made with this clue: ${guessesThisTurn} (${correctGuesses.length} correct, ${incorrectGuesses.length} incorrect)
- Guesses remaining for this clue: ${Math.max(0, currentClue.number - guessesThisTurn)}
- Score: ${team} ${currentTeamScore} - ${team === "red" ? "blue" : "red"} ${opposingTeamScore} (${gameState}, difference: ${scoreDifference})
- Game phase: ${gamePhase.toUpperCase()} (${wordsToWin} words needed to win)
- Risk posture: ${riskAssessment}
- Available words: ${availableWords.length} words remain on the board
- Words already revealed: ${revealedCards.length} cards revealed

CORRECT GUESSES FOR THIS CLUE:
${correctGuesses.length > 0 ? correctGuesses.join(", ") : "None yet"}

TEAM DISCUSSION HISTORY:
${discussionText}

CANDIDATE WORDS FROM DISCUSSION (ranked by team support):
${candidateWordsList || "No candidate words found in discussion"}

STRATEGIC CONSIDERATIONS:
1. Clue effectiveness: How well has this clue worked so far? (${correctGuesses.length} correct, ${incorrectGuesses.length} incorrect)
2. Remaining opportunities: Are there strong candidate words left worth guessing?
3. Risk analysis: What's the likelihood of hitting an opponent's word or the assassin?
4. Score considerations: Given the current score (${team} ${currentTeamScore} - ${team === "red" ? "blue" : "red"} ${opposingTeamScore}), is caution or aggression better?
5. Long-term strategy: Will ending the turn now set up better opportunities in future turns?
6. Team consensus: Is there clear agreement on a next word, or is the team uncertain?

As the ${model} AI team member, you need to make a Team Voting Decision:
1. CONTINUE guessing if there's a promising candidate word with good team consensus
2. END TURN if the risk is too high or there are no strong candidates remaining

Make this strategic decision considering both the discussion and game state.
Respond in JSON format with:
{
  "action": "continue" OR "end_turn",
  "reasoning": "detailed explanation of your Team Voting Decision",
  "confidence": number between 0-1 representing your certainty
}`;

  switch (model) {
    case "gpt-4o":
      return await getOpenAIMetaDecision(prompt);
    case "claude-sonnet-4-5-20250929":
      return await getAnthropicMetaDecision(prompt);
    case "grok-4-fast-reasoning":
      return await getXAIMetaDecision(prompt);
    case "gemini-1.5-pro":
      return await getGeminiMetaDecision(prompt);
    default:
      throw new Error(`Invalid AI model: ${model}`);
  }
}

// Implementation of model-specific meta decision functions
async function getOpenAIMetaDecision(prompt: string): Promise<{ 
  action: "continue" | "end_turn"; 
  reasoning: string; 
  confidence: number;
}> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return validateMetaDecision(JSON.parse(content));
}

async function getAnthropicMetaDecision(prompt: string): Promise<{ 
  action: "continue" | "end_turn"; 
  reasoning: string; 
  confidence: number;
}> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'I am a Codenames AI player making a strategic decision about continuing or ending my turn. I will respond in JSON format.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        action: "end_turn",
        reasoning: "Could not parse response, defaulting to ending turn for safety",
        confidence: 0.5
      };
    }

    return validateMetaDecision(JSON.parse(jsonMatch[0]));
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    return {
      action: "end_turn",
      reasoning: "Error processing response, defaulting to ending turn for safety",
      confidence: 0.5
    };
  }
}

async function getXAIMetaDecision(prompt: string): Promise<{ 
  action: "continue" | "end_turn"; 
  reasoning: string; 
  confidence: number;
}> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return validateMetaDecision(JSON.parse(content));
}

async function getGeminiMetaDecision(prompt: string): Promise<{ 
  action: "continue" | "end_turn"; 
  reasoning: string; 
  confidence: number;
}> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ text: prompt }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      return validateMetaDecision(parsed);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        return validateMetaDecision(extracted);
      }
      throw new Error("Failed to parse Gemini meta decision response");
    }
  } catch (error) {
    console.error("Error in Gemini meta decision:", error);
    return {
      action: "end_turn",
      reasoning: "Error processing response, defaulting to ending turn for safety",
      confidence: 0.5
    };
  }
}

function validateMetaDecision(response: any): { 
  action: "continue" | "end_turn"; 
  reasoning: string; 
  confidence: number;
} {
  if (!response.action || !["continue", "end_turn"].includes(response.action)) {
    response.action = "end_turn"; // Safer default
  }
  
  if (!response.reasoning || typeof response.reasoning !== "string") {
    response.reasoning = response.action === "continue"
      ? "Based on the current game state and discussion, continuing with another guess is the optimal strategy."
      : "Based on the current game state and discussion, ending the turn is the safer option.";
  }
  
  if (typeof response.confidence !== "number" || response.confidence < 0 || response.confidence > 1) {
    response.confidence = response.action === "continue" ? 0.7 : 0.8; // Higher confidence for ending turn by default
  }
  
  return response;
}

export async function makeAgentDecision(
  model: AIModel,
  team: "red" | "blue",
  word: string,
  currentClue: { word: string; number: number },
  teamDiscussion: TeamDiscussionEntry[],
  availableWords: string[],
  revealedWords: string[],
  guessesThisTurn: number,
  gameId: number = 1
): Promise<{ 
  decision: "guess" | "end_turn" | "continue_discussion"; 
  explanation: string; 
  confidence: number;
}> {
  // Format the team discussion in a readable way
  // Include explicit indications of which words agents have suggested
  const discussionText = teamDiscussion
    .map(d => {
      let wordText = "";
      if (d.suggestedWord) {
        wordText = ` [Suggests: ${d.suggestedWord}]`;
      } else if (d.suggestedWords && d.suggestedWords.length > 0) {
        wordText = ` [Suggests: ${d.suggestedWords.join(", ")}]`;
      }
      return `${d.player}: ${d.message}${wordText}`;
    })
    .join('\n');
  
  // Get word suggestions for ranking
  const suggestedWordCounts = new Map<string, { 
    count: number, 
    supporters: Set<string>, 
    opposers: Set<string>,
    totalConfidence: number 
  }>();
  
  // Track suggestions and oppositions
  teamDiscussion.forEach(entry => {
    // Process single suggestion
    if (entry.suggestedWord) {
      if (!suggestedWordCounts.has(entry.suggestedWord)) {
        suggestedWordCounts.set(entry.suggestedWord, { 
          count: 0, 
          supporters: new Set(), 
          opposers: new Set(),
          totalConfidence: 0 
        });
      }
      
      const data = suggestedWordCounts.get(entry.suggestedWord)!;
      data.count++;
      
      if (entry.confidence > 0.5) {
        data.supporters.add(entry.player);
        data.totalConfidence += entry.confidence;
      } else if (entry.confidence < 0.3) {
        data.opposers.add(entry.player);
      }
    }
    
    // Process multiple suggestions
    if (entry.suggestedWords && entry.suggestedWords.length > 0) {
      entry.suggestedWords.forEach(word => {
        if (!suggestedWordCounts.has(word)) {
          suggestedWordCounts.set(word, { 
            count: 0, 
            supporters: new Set(), 
            opposers: new Set(),
            totalConfidence: 0 
          });
        }
        
        const data = suggestedWordCounts.get(word)!;
        data.count++;
        
        if (entry.confidence > 0.5) {
          data.supporters.add(entry.player);
          data.totalConfidence += entry.confidence;
        } else if (entry.confidence < 0.3) {
          data.opposers.add(entry.player);
        }
      });
    }
    
    // Check for disagreements/oppositions in message text
    const messageLower = entry.message.toLowerCase();
    
    // Only check for oppositions if confidence is low or message contains negative language
    const hasNegativeLanguage = messageLower.includes("disagree") || 
                             messageLower.includes("not sure") || 
                             messageLower.includes("risky") || 
                             messageLower.includes("dangerous") ||
                             messageLower.includes("don't think");
    
    if (entry.confidence < 0.4 || hasNegativeLanguage) {
      // Look for mentioned words that this agent is opposing
      for (const [word, _] of suggestedWordCounts.entries()) {
        if (messageLower.includes(word.toLowerCase()) && 
            (hasNegativeLanguage || entry.confidence < 0.3)) {
          suggestedWordCounts.get(word)!.opposers.add(entry.player);
        }
      }
    }
  });
  
  // Format word ranking
  const wordRankingText = Array.from(suggestedWordCounts.entries())
    .sort((a, b) => {
      // Primary sort: supporters count
      const supportDiff = b[1].supporters.size - a[1].supporters.size;
      if (supportDiff !== 0) return supportDiff;
      
      // Secondary sort: mention count
      const mentionDiff = b[1].count - a[1].count;
      if (mentionDiff !== 0) return mentionDiff;
      
      // Tertiary sort: confidence
      return b[1].totalConfidence - a[1].totalConfidence;
    })
    .map(([word, data]) => {
      const avgConfidence = data.totalConfidence / Math.max(1, data.supporters.size);
      return `"${word}": mentioned ${data.count} times, supported by ${Array.from(data.supporters).join(", ")} (${data.supporters.size}), opposed by ${Array.from(data.opposers).join(", ")} (${data.opposers.size}), avg confidence: ${(avgConfidence * 100).toFixed(0)}%`;
    })
    .join('\n');
  
  const participants = new Set(teamDiscussion.map(d => d.player));
  const discussionRounds = Math.max(...teamDiscussion.map(d => d.round || 1));
  
  // Create a prompt for the agent to make an autonomous decision
  const prompt = `You are playing Codenames as a ${team} team player with the role of ${model}. You are asked to make a decision about ${word}.

GAME STATE:
- Current clue: "${currentClue.word}" (${currentClue.number})
- Word being considered: "${word}"
- Guesses made this turn: ${guessesThisTurn}
- Guesses remaining for this clue: ${currentClue.number - guessesThisTurn}
- Available words: ${availableWords.join(", ")}
- Words already revealed: ${revealedWords.join(", ")}
- Discussion has gone for ${discussionRounds} rounds with ${participants.size} participants

TEAM DISCUSSION:
${discussionText}

WORD RANKING (based on team discussion):
${wordRankingText}

As a team member, you need to decide:
1. Do you want to GUESS "${word}" now?
2. Should the team END TURN because this word is too risky or doesn't fit the clue well?
3. Should the team CONTINUE DISCUSSION to reach a better consensus?

Consider:
- Does "${word}" have strong connections to the clue "${currentClue.word}"?
- How many team members support this word vs. oppose it?
- Is there another word with stronger team support?
- Has the discussion been thorough enough to make a decision?
- What is your personal assessment of the risk?

Make an autonomous decision as a team member, NOT as a coordinator or judge.
Respond in JSON format with:
{
  "decision": "guess" OR "end_turn" OR "continue_discussion",
  "explanation": "your personal reasoning for this decision",
  "confidence": number between 0-1 representing your certainty
}`;

  switch (model) {
    case "gpt-4o":
      return await getOpenAIDecision(prompt);
    case "claude-sonnet-4-5-20250929":
      return await getAnthropicDecision(prompt);
    case "grok-4-fast-reasoning":
      return await getXAIDecision(prompt);
    case "gemini-1.5-pro":
      return await getGeminiDecision(prompt);
    default:
      throw new Error(`Invalid AI model: ${model}`);
  }
}

// Helper implementations for agent decisions
async function getOpenAIDecision(prompt: string): Promise<{ 
  decision: "guess" | "end_turn" | "continue_discussion"; 
  explanation: string; 
  confidence: number;
}> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return validateAgentDecision(JSON.parse(content));
}

async function getAnthropicDecision(prompt: string): Promise<{ 
  decision: "guess" | "end_turn" | "continue_discussion"; 
  explanation: string; 
  confidence: number;
}> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'I am a Codenames AI player making an autonomous decision. I will respond in valid JSON format.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        decision: "continue_discussion",
        explanation: "Unable to parse response, defaulting to continuing discussion",
        confidence: 0.3
      };
    }

    return validateAgentDecision(JSON.parse(jsonMatch[0]));
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    return {
      decision: "continue_discussion",
      explanation: "Error processing response, defaulting to continuing discussion",
      confidence: 0.3
    };
  }
}

async function getXAIDecision(prompt: string): Promise<{ 
  decision: "guess" | "end_turn" | "continue_discussion"; 
  explanation: string; 
  confidence: number;
}> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return validateAgentDecision(JSON.parse(content));
}

async function getGeminiDecision(prompt: string): Promise<{ 
  decision: "guess" | "end_turn" | "continue_discussion"; 
  explanation: string; 
  confidence: number;
}> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ text: prompt }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    
    try {
      const parsed = JSON.parse(sanitizedText);
      return validateAgentDecision(parsed);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        return validateAgentDecision(extracted);
      }
      throw new Error("Failed to parse Gemini decision response");
    }
  } catch (error) {
    console.error("Error in Gemini decision:", error);
    return {
      decision: "continue_discussion",
      explanation: "Error processing response, defaulting to continuing discussion",
      confidence: 0.3
    };
  }
}

function validateAgentDecision(response: any): { 
  decision: "guess" | "end_turn" | "continue_discussion"; 
  explanation: string; 
  confidence: number;
} {
  if (!response.decision || !["guess", "end_turn", "continue_discussion"].includes(response.decision)) {
    response.decision = "continue_discussion"; // Safe default
  }
  
  if (!response.explanation || typeof response.explanation !== "string") {
    response.explanation = response.decision === "guess" 
      ? "This word has a strong connection to the clue" 
      : response.decision === "end_turn"
      ? "The risk is too high for this word"
      : "We need more discussion to reach consensus";
  }
  
  if (typeof response.confidence !== "number" || response.confidence < 0 || response.confidence > 1) {
    response.confidence = response.decision === "guess" ? 0.7 : 0.5;
  }
  
  return response;
}

async function getOpenAIClue(prompt: string): Promise<{ word: string; number: number; reasoning?: string }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });
  
  const content = sanitizeJsonResponse(response.choices[0].message.content || "");
  const result = JSON.parse(content);
  
  return {
    word: result.word,
    number: result.number,
    reasoning: result.reasoning
  };
}

async function getAnthropicClue(prompt: string): Promise<{ word: string; number: number; reasoning?: string }> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'I am a Codenames AI assistant that only responds with valid JSON objects containing "word" and "number" fields.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in response");
    }

    // First sanitize the content to remove any control characters
    const sanitizedContent = jsonMatch[0].replace(/[\x00-\x1F\x7F]/g, "");
    // Clean up malformed JSON by removing trailing commas before closing brackets/braces
    const cleanedJson = sanitizedContent.replace(/,(\s*[}\]])/g, '$1');
    
    const result = JSON.parse(cleanedJson);
    if (!result.word || typeof result.number !== 'number') {
      throw new Error("Invalid response format from Anthropic");
    }

    return {
      word: result.word,
      number: result.number,
      reasoning: result.reasoning
    };
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    throw new Error("Failed to parse Anthropic response");
  }
}

async function getXAIClue(prompt: string): Promise<{ word: string; number: number; reasoning?: string }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1/chat/completions",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  const result = JSON.parse(content) as { word: string; number: number };
  if (!result.word || typeof result.number !== 'number') {
    throw new Error("Invalid response format from xAI");
  }

  return result;
}

async function getOpenAIGuess(prompt: string): Promise<{ guess: string }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return JSON.parse(content) as { guess: string };
}

async function getAnthropicGuess(prompt: string): Promise<{ guess: string }> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'You are a Codenames AI assistant that MUST ONLY respond with valid JSON objects containing a "guess" field. Never include explanations outside of the JSON.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    // If response starts with explanation text, try to extract JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in response");
    }

    const result = JSON.parse(jsonMatch[0]);
    if (!result.guess || typeof result.guess !== 'string') {
      throw new Error("Invalid response format from Anthropic");
    }

    return result;
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    throw new Error("Failed to parse Anthropic response");
  }
}

async function getXAIGuess(prompt: string): Promise<{ guess: string }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return JSON.parse(content) as { guess: string };
}

async function getOpenAIDiscussion(prompt: string): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return JSON.parse(content) as { message: string; confidence: number; suggestedWord?: string };
}

async function getAnthropicDiscussion(prompt: string): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'I am a Codenames AI assistant that MUST ONLY respond with valid JSON objects containing "message" and "confidence" fields, and optionally a "suggestedWord" field. Never include explanations outside of the JSON.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    // If response starts with explanation text, try to extract JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        message: "I encountered an error processing the response. Let's continue our discussion.",
        confidence: 0.5
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    if (!result.message || typeof result.confidence !== 'number') {
      return {
        message: "I encountered a format error. Let's proceed with the discussion.",
        confidence: 0.5
      };
    }

    return result;
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    return {
      message: "I encountered an error processing the response. Let's proceed with caution.",
      confidence: 0.5
    };
  }
}

async function getXAIDiscussion(prompt: string): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return JSON.parse(content) as { message: string; confidence: number; suggestedWord?: string };
}

async function getOpenAIVote(prompt: string): Promise<{ approved: boolean; reason: string; confidence: number }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  const result = JSON.parse(content) as { approved: boolean; reason: string; confidence: number };
  // If confidence is missing, add a default value
  if (typeof result.confidence !== 'number') {
    result.confidence = result.approved ? 0.8 : 0.3;
  }
  return result;
}

async function getAnthropicVote(prompt: string): Promise<{ approved: boolean; reason: string; confidence: number }> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      { 
        role: 'assistant', 
        content: 'You are a Codenames AI assistant that MUST ONLY respond with valid JSON objects containing "approved", "reason", and "confidence" fields. The confidence should be a number between 0-1 indicating how confident you are in your decision. Never include explanations outside of the JSON.' 
      },
      { 
        role: 'user', 
        content: prompt 
      }
    ],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text.trim();
    // If response starts with explanation text, try to extract JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        approved: false,
        reason: "Could not process voting decision due to response format error.",
        confidence: 0.3
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    if (typeof result.approved !== 'boolean' || typeof result.reason !== 'string') {
      return {
        approved: false,
        reason: "Could not process voting decision due to invalid response format.",
        confidence: 0.3
      };
    }

    // Add confidence if missing
    if (typeof result.confidence !== 'number') {
      result.confidence = result.approved ? 0.8 : 0.3;
    }

    return result;
  } catch (error) {
    console.error("Error parsing Anthropic vote response:", error);
    return {
      approved: false,
      reason: "Could not process the voting decision due to an error.",
      confidence: 0.3
    };
  }
}

async function getXAIVote(prompt: string): Promise<{ approved: boolean; reason: string; confidence: number }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-4-fast-reasoning",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  const result = JSON.parse(content) as { approved: boolean; reason: string; confidence?: number };
  
  // Add confidence if missing
  if (typeof result.confidence !== 'number') {
    result.confidence = result.approved ? 0.8 : 0.3;
  }
  
  return result as { approved: boolean; reason: string; confidence: number };
}

// Helper function for consistent model display names
function getModelDisplayName(model: AIModel): string {
  switch (model) {
    case "gpt-4o":
      return "GPT-4";
    case "claude-sonnet-4-5-20250929":
      return "Claude";
    case "grok-4-fast-reasoning":
      return "Grok";
    case "gemini-1.5-pro":
      return "Gemini";
    default:
      return "Unknown AI";
  }
}

// Update the model info helper
function getModelInfo(model: AIModel): { name: string; service: AIService } {
  const service = getAIService(model);
  return {
    name: getModelDisplayName(model),
    service
  };
}

// Add memory of past successful/failed guesses
const teamMemory = new Map<string, {
  successfulGuesses: string[];
  failedGuesses: string[];
  clueHistory: { clue: string; number: number; success: boolean }[];
}>();

// Cache for spymaster background thinking
type SpymasterThinkingCache = {
  clue: { word: string; number: number; reasoning?: string };
  score: number;
  timestamp: number;
  gameState: string; // To track if game state has changed
  scoreDetails?: {
    teamWordScore: number;
    assassinPenalty: number;
    opponentPenalty: number;
    neutralPenalty: number;
    uniquenessBonus: number;
  };
};

const spymasterThinkingCache = new Map<string, SpymasterThinkingCache>();

// Get the best clue from the cache for a given game state
export function getBestSpymasterClue(gameId: number, team: "red" | "blue"): { word: string; number: number; reasoning?: string; score: number } | null {
  // Get all cache entries for this team
  const teamEntries = Array.from(spymasterThinkingCache.entries())
    .filter(([key]) => key.includes(`-${team}-${gameId}`))
    .map(([_, entry]) => entry);
  
  if (teamEntries.length === 0) {
    return null;
  }
  
  // Sort by score (highest first) and return the best one
  const bestEntry = teamEntries.sort((a, b) => b.score - a.score)[0];
  return {
    word: bestEntry.clue.word,
    number: bestEntry.clue.number,
    reasoning: bestEntry.clue.reasoning,
    score: bestEntry.score
  };
}

export function updateTeamMemory(
  team: string,
  clue: { word: string; number: number },
  guess: string,
  success: boolean
) {
  const memory = teamMemory.get(team) || {
    successfulGuesses: [],
    failedGuesses: [],
    clueHistory: []
  };

  if (success) {
    memory.successfulGuesses.push(guess);
  } else {
    memory.failedGuesses.push(guess);
  }

  memory.clueHistory.push({
    clue: clue.word,
    number: clue.number,
    success
  });

  teamMemory.set(team, memory);
}

async function getGeminiClue(prompt: string): Promise<{ word: string; number: number }> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  try {
    const result = await model.generateContent({
      contents: [{ 
        role: "user", 
        parts: [{ text: `${prompt}\n\nRespond ONLY with a JSON object in this format:\n{\n  "word": "clue",\n  "number": count\n}` }] 
      }],
    });
    const text = result.response.text().trim();
    const sanitizedText = sanitizeJsonResponse(text);
    return JSON.parse(sanitizedText);
  } catch (error) {
    console.error("Error in Gemini clue:", error);
    throw new Error("Failed to get clue from Gemini");
  }
}

// Memory system for tracking game state and past discussions
interface WordAssociation {
  word: string;
  clue: string;
  confidence: number;
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
  supporters: string[];
  opposers: string[];
  risk: RiskLevel;
  relatedWords: string[];
  status: "active" | "guessed" | "rejected" | "uncertain";
}

// Game memory to persist across turns
const gameMemory = new Map<string, {
  activeClues: Map<string, {
    clue: string;
    number: number;
    timestamp: number;
    suggestedWords: WordAssociation[];
    guessedWords: string[];
    remainingGuesses: number;
  }>;
  wordAssociations: Map<string, WordAssociation[]>;
  discussionHistory: {
    round: number;
    timestamp: number;
    wordSuggestions: string[];
    conflicts: {wordA: string, wordB: string, resolved: boolean}[];
  }[];
}>();

// Imports from game-memory.ts
import { getTeamMemory, updateDiscussionMemory, getActiveClues, updateTurnResults } from './game-memory';

// Update memory with new discussion information
// This function is now imported from game-memory.ts
function updateDiscussionMemoryLocal(
  team: string,
  clue: { word: string; number: number },
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  revealedCards: string[],
  currentRound: number
): void {
  console.log(`📝 Updating team memory for ${team}, clue: "${clue.word}", round: ${currentRound}`);
  
  const teamMemory = getTeamMemory(team);
  const clueKey = clue.word;
  const now = Date.now();
  
  // Initialize or update active clue
  if (!teamMemory.activeClues.has(clueKey)) {
    // This is a new clue
    teamMemory.activeClues.set(clueKey, {
      clue: clue.word,
      number: clue.number,
      timestamp: now,
      suggestedWords: [],
      guessedWords: [],
      remainingGuesses: clue.number
    });
    console.log(`🆕 Adding new active clue: "${clue.word}" (${clue.number})`);
  }
  
  const activeClue = teamMemory.activeClues.get(clueKey)!;
  
  // Update guessed words for this clue
  const guessesForThisClue = gameHistory.filter(entry => 
    entry.type === "guess" && 
    entry.relatedClue === clue.word &&
    entry.word
  ).map(entry => entry.word);
  
  activeClue.guessedWords = guessesForThisClue;
  activeClue.remainingGuesses = Math.max(0, clue.number - guessesForThisClue.length);
  
  // Process all word suggestions from the discussion
  const wordSuggestions = new Map<string, {
    confidence: number,
    supporters: Set<string>,
    opposers: Set<string>,
    mentions: number,
    lastMentioned: number,
    risk: RiskLevel
  }>();
  
  // Track conflicts between words
  const conflicts = new Set<string>();
  
  // First pass: collect all word suggestions
  teamDiscussion.forEach(entry => {
    if (entry.suggestedWord && !revealedCards.includes(entry.suggestedWord)) {
      const word = entry.suggestedWord;
      
      if (!wordSuggestions.has(word)) {
        wordSuggestions.set(word, {
          confidence: 0,
          supporters: new Set<string>(),
          opposers: new Set<string>(),
          mentions: 0,
          lastMentioned: entry.timestamp,
          risk: entry.risk || "Medium"
        });
      }
      
      const wordData = wordSuggestions.get(word)!;
      wordData.mentions += 1;
      wordData.lastMentioned = Math.max(wordData.lastMentioned, entry.timestamp);
      
      // Support or opposition is determined by confidence
      if (entry.confidence >= 0.6) {
        wordData.supporters.add(entry.player);
        wordData.confidence += entry.confidence;
      } else if (entry.confidence < 0.3) {
        wordData.opposers.add(entry.player);
      }
      
      // Update risk assessment (prioritize higher risk)
      if (entry.risk === "High" || (entry.risk === "Medium" && wordData.risk === "Low")) {
        wordData.risk = entry.risk;
      }
    }
  });
  
  // Second pass: identify conflicts in the discussion
  const entries = teamDiscussion.slice().sort((a, b) => a.timestamp - b.timestamp);
  
  // Track who has suggested what
  const agentSuggestions = new Map<string, string[]>();
  
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    
    if (entry.suggestedWord) {
      // Track this agent's suggestions
      if (!agentSuggestions.has(entry.player)) {
        agentSuggestions.set(entry.player, []);
      }
      
      const suggestions = agentSuggestions.get(entry.player)!;
      if (!suggestions.includes(entry.suggestedWord)) {
        suggestions.push(entry.suggestedWord);
      }
      
      // Look for explicit disagreements in the message text
      const msgLower = entry.message.toLowerCase();
      const isDisagreement = 
        msgLower.includes("disagree") || 
        msgLower.includes("don't think") || 
        msgLower.includes("not sure") || 
        msgLower.includes("too risky") || 
        msgLower.includes("instead of") ||
        msgLower.includes("rather than");
      
      // If this is a disagreement, look for what words they might be disagreeing with
      if (isDisagreement) {
        // Check previously suggested words from other agents
        for (const [otherAgent, otherSuggestions] of agentSuggestions.entries()) {
          if (otherAgent !== entry.player) {
            for (const otherWord of otherSuggestions) {
              if (otherWord !== entry.suggestedWord && msgLower.includes(otherWord.toLowerCase())) {
                // Found an explicit disagreement
                conflicts.add(`${otherWord}-${entry.suggestedWord}`);
                
                // Add to opposers
                const wordData = wordSuggestions.get(otherWord);
                if (wordData) {
                  wordData.opposers.add(entry.player);
                }
                
                console.log(`🔄 Detected conflict between "${otherWord}" and "${entry.suggestedWord}"`);
              }
            }
          }
        }
      }
    }
  };
  
  // Update active clue with suggested words
  activeClue.suggestedWords = Array.from(wordSuggestions.entries())
    .map(([word, data]) => ({
      word,
      clue: clue.word,
      confidence: data.confidence / Math.max(1, data.supporters.size),
      mentionCount: data.mentions,
      firstMentionedAt: now, // Approximate
      lastMentionedAt: data.lastMentioned,
      supporters: Array.from(data.supporters),
      opposers: Array.from(data.opposers),
      risk: data.risk,
      relatedWords: [], // Will be populated later
      status: revealedCards.includes(word) ? "guessed" : 
              data.opposers.size > data.supporters.size ? "rejected" : 
              data.supporters.size > 0 ? "active" : "uncertain"
    }))
    .sort((a, b) => {
      // First by support ratio (supporters - opposers)
      const supportRatioA = a.supporters.length - a.opposers.length;
      const supportRatioB = b.supporters.length - b.opposers.length;
      if (supportRatioB !== supportRatioA) {
        return supportRatioB - supportRatioA;
      }
      // Then by confidence
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      // Finally by mention count
      return b.mentionCount - a.mentionCount;
    });
  
  // Update word associations
  activeClue.suggestedWords.forEach(association => {
    if (!teamMemory.wordAssociations.has(association.word)) {
      teamMemory.wordAssociations.set(association.word, []);
    }
    
    const associations = teamMemory.wordAssociations.get(association.word)!;
    const existingAssoc = associations.find(a => a.clue === clue.word);
    
    if (existingAssoc) {
      // Update existing association
      existingAssoc.confidence = Math.max(existingAssoc.confidence, association.confidence);
      existingAssoc.mentionCount += association.mentionCount;
      existingAssoc.lastMentionedAt = association.lastMentionedAt;
      existingAssoc.supporters = [...new Set([...existingAssoc.supporters, ...association.supporters])];
      existingAssoc.opposers = [...new Set([...existingAssoc.opposers, ...association.opposers])];
      existingAssoc.status = association.status;
      existingAssoc.risk = association.risk === "High" || existingAssoc.risk === "High" ? 
                          "High" : (association.risk === "Medium" || existingAssoc.risk === "Medium" ? 
                                  "Medium" : "Low");
    } else {
      // Add new association
      associations.push(association);
    }
  });
  
  // Find related words based on common clues
  for (const [word, associations] of teamMemory.wordAssociations.entries()) {
    associations.forEach(assoc => {
      // Find other words associated with the same clue
      const relatedWords = new Set<string>();
      
      for (const [otherWord, otherAssocs] of teamMemory.wordAssociations.entries()) {
        if (otherWord !== word) {
          const hasCommonClue = otherAssocs.some(a => a.clue === assoc.clue);
          if (hasCommonClue) {
            relatedWords.add(otherWord);
          }
        }
      }
      
      assoc.relatedWords = Array.from(relatedWords);
    });
  }
  
  // Update discussion history
  teamMemory.discussionHistory.push({
    round: currentRound,
    timestamp: now,
    wordSuggestions: Array.from(wordSuggestions.keys()),
    conflicts: Array.from(conflicts).map(conflictStr => {
      const [wordA, wordB] = conflictStr.split('-');
      
      // A conflict is considered resolved if supporters of one word significantly
      // outnumber the supporters of the other word
      const dataA = wordSuggestions.get(wordA);
      const dataB = wordSuggestions.get(wordB);
      
      let resolved = false;
      if (dataA && dataB) {
        const supportersA = dataA.supporters.size;
        const supportersB = dataB.supporters.size;
        resolved = Math.abs(supportersA - supportersB) >= 2;
      }
      
      return { wordA, wordB, resolved };
    })
  });
  
  console.log(`📊 Memory updated for clue "${clue.word}". Active words: ${activeClue.suggestedWords.map(w => w.word).join(', ')}`);
  
  // Clean up old clues if they're fully guessed or invalid
  for (const [clueKey, clueData] of teamMemory.activeClues.entries()) {
    // If all guesses used or all suggested words are revealed, mark as inactive
    const allSuggestedWordsRevealed = clueData.suggestedWords.length > 0 && 
                                     clueData.suggestedWords.every(w => revealedCards.includes(w.word));
    
    const allGuessesUsed = clueData.remainingGuesses <= 0;
    
    if (allSuggestedWordsRevealed || allGuessesUsed) {
      if (clueKey !== clue.word) { // Don't remove the current clue
        console.log(`🗑️ Cleaning up inactive clue: "${clueKey}"`);
        teamMemory.activeClues.delete(clueKey);
      }
    }
  }
}

// Functions now imported from game-memory.ts

// New function to trigger background thinking for spymaster to improve clues over time
export async function backgroundSpymasterThinking(
  gameId: number,
  model: string | AIModel,
  words: string[],
  teamWords: string[],
  opposingWords: string[],
  assassinWord: string,
  gameHistory: GameHistoryEntry[] | null | undefined,
  gameState: string | null | undefined,
  redScore: number | undefined,
  blueScore: number | undefined,
  revealedCards: string[] = [],
  currentTeam: "red" | "blue"
): Promise<void> {
  // Skip if the model is invalid
  if (!VALID_MODELS.includes(model as AIModel)) {
    console.log(`Skipping background thinking for invalid model: ${model}`);
    return;
  }

  try {
    const validatedModel = validateModel(model as AIModel);
    
    // Filter words to only include unrevealed ones
    const unrevealed = teamWords.filter(word => !revealedCards.includes(word));
    if (unrevealed.length === 0) {
      console.log(`No unrevealed words for team ${currentTeam}, skipping background thinking`);
      return;
    }
    
    // Create a unique key for the cache
    const cacheKey = `${validatedModel}-${currentTeam}-${gameId}-${unrevealed.join(",")}`;
    const gameStateHash = `${redScore}-${blueScore}-${revealedCards.length}`;
    
    // Get existing cached entries for this particular configuration
    const existing = spymasterThinkingCache.get(cacheKey);
    
    // Generate a new clue if:
    // 1. We don't have one cached yet, or
    // 2. The game state has changed, or
    // 3. It's been a while since we last thought about this (continuous improvement)
    const needsNewThinking = !existing || 
                           existing.gameState !== gameStateHash || 
                           Date.now() - existing.timestamp > 30000; // Re-think every 30 seconds
    
    if (needsNewThinking) {
      console.log(`🧠 Deep background thinking for spymaster ${model} (team: ${currentTeam})`);
      
      // Call getSpymasterClue with a flag to avoid using the cache (to prevent recursion)
      const clue = await getSpymasterClue(
        model as AIModel,
        words,
        teamWords,
        opposingWords,
        assassinWord,
        gameHistory,
        gameState as any, // Type cast to match expected type
        redScore,
        blueScore,
        revealedCards,
        false // Don't use the cache to avoid recursion
      );
      
      // Score the clue using our sophisticated scoring system
      const { score, details } = evaluateClueQuality(clue, teamWords, opposingWords, assassinWord, gameHistory, words);
      
      // Update the cache with the new clue and its score
      spymasterThinkingCache.set(cacheKey, {
        clue,
        score,
        timestamp: Date.now(),
        gameState: gameStateHash,
        scoreDetails: details
      });
      
      // Detailed logging for debugging and monitoring
      console.log(`🧠 Background thinking results for ${clue.word} (${clue.number}):`); 
      console.log(`  Score: ${score.toFixed(2)}`);
      console.log(`  Team word score: +${details.teamWordScore.toFixed(2)}`);
      console.log(`  Assassin penalty: -${details.assassinPenalty.toFixed(2)}`);
      console.log(`  Opponent penalty: -${details.opponentPenalty.toFixed(2)}`);
      console.log(`  Neutral penalty: -${details.neutralPenalty.toFixed(2)}`);
      console.log(`  Uniqueness bonus: +${details.uniquenessBonus.toFixed(2)}`);
      
      // Log dangerous words if any were found
      if (details.dangerousWords && details.dangerousWords.length > 0) {
        console.log(`  ⚠️ DANGEROUS WORD ALERTS:`);
        details.dangerousWords.forEach(warning => {
          console.log(`    ${warning}`);
        });
        if (score < 0) {
          console.log(`  🛑 CLUE VETOED - Too dangerous to use!`);
        }
      }
      
      // Get all current clues for this team and find the best one
      const bestClue = getBestSpymasterClue(gameId, currentTeam);
      if (bestClue) {
        console.log(`🏆 Current best clue for ${currentTeam}: ${bestClue.word} (${bestClue.number}) - Score: ${bestClue.score.toFixed(2)}`);
      }
    } else {
      console.log(`⏭️ Skipping background thinking for ${model} (team: ${currentTeam}) - already thought recently`);
    }
  } catch (error) {
    console.error('Error in background spymaster thinking:', error);
    // Don't throw, this is a background process
  }
}

// Helper function to evaluate clue quality with a sophisticated scoring system
function evaluateClueQuality(
  clue: { word: string; number: number; reasoning?: string },
  teamWords: string[],
  opposingWords: string[],
  assassinWord: string,
  gameHistory: GameHistoryEntry[] | null | undefined,
  allGameWords: string[]
): { score: number; details: { teamWordScore: number; assassinPenalty: number; opponentPenalty: number; neutralPenalty: number; uniquenessBonus: number; dangerousWords: string[] } } {
  // Calculate the base team word score - this is our positive reward component
  // We want to reward clues that connect more team words
  const teamWordScore = clue.number * 15; // Increased from 10 to emphasize team word connections
  
  // Get past clues to check for uniqueness
  const safeGameHistory = Array.isArray(gameHistory) ? gameHistory : [];
  const pastClues = safeGameHistory
    .filter(entry => entry.type === "clue")
    .map(entry => {
      const content = entry.content || "";
      // Extract the actual clue word from format like "Spymaster gives clue: word (3)"
      const match = content.match(/clue: ([a-zA-Z0-9]+)/);
      return match ? match[1].toLowerCase() : "";
    })
    .filter(word => word.length > 0);
  
  // Bonus for novel, unique clues not used before
  const uniquenessBonus = !pastClues.includes(clue.word.toLowerCase()) ? 20 : 0;
  
  // CRITICAL: Heavily penalize any semantic similarity to the assassin word
  // The precise number doesn't matter since this is relative to other clues
  // but we want this to be a severe penalty that's hard to overcome
  const assassinSimilarity = estimateWordSimilarity(clue.word, assassinWord);
  const assassinPenalty = assassinSimilarity * 700; // Increased from 500
  
  // Track dangerous words for detailed reporting
  const dangerousWords: string[] = [];
  if (assassinSimilarity > 0.3) {
    dangerousWords.push(`ASSASSIN: ${assassinWord} (${(assassinSimilarity * 100).toFixed(0)}%)`);
  }
  
  // Significant penalty for opponent words - we don't want our team
  // to accidentally guess opponent words
  let opponentPenalty = 0;
  for (const oppWord of opposingWords) {
    const similarity = estimateWordSimilarity(clue.word, oppWord);
    opponentPenalty += similarity * 300; // Increased from 200 for greater safety
    
    // Track highly similar opposing words
    if (similarity > 0.3) {
      dangerousWords.push(`OPPONENT: ${oppWord} (${(similarity * 100).toFixed(0)}%)`);
    }
  }
  
  // Check for potential misleading clues by testing team members' understanding
  // For each team word, estimate how likely it is to be guessed from this clue
  const teamWordSimilarities = teamWords.map(word => ({
    word,
    similarity: estimateWordSimilarity(clue.word, word)
  }));
  
  // Sort by similarity to see which team words are most likely to be guessed
  const sortedTeamSimilarities = teamWordSimilarities.sort((a, b) => b.similarity - a.similarity);
  
  // Check if we have fewer high-similarity words than the clue number suggests
  // This indicates the clue might be misleading and cause guessing of non-team words
  const highSimilarityTeamWords = sortedTeamSimilarities.filter(item => item.similarity > 0.3);
  if (highSimilarityTeamWords.length < clue.number) {
    // The clue suggests more connections than we can confidently identify
    // This increases risk of guessing wrong words - apply an additional penalty
    const misleadingPenalty = (clue.number - highSimilarityTeamWords.length) * 50;
    opponentPenalty += misleadingPenalty;
  }
  
  // Light penalty for neutral words - suboptimal but not as bad as opponent words
  const allWords = [assassinWord, ...teamWords, ...opposingWords];
  const remainingWords = allGameWords.filter(w => !allWords.includes(w)); // These are neutral words
  
  let neutralPenalty = 0;
  const neutralSimilarities = remainingWords.map(word => ({
    word,
    similarity: estimateWordSimilarity(clue.word, word)
  }));
  
  // Penalize for neutral words with high similarity
  const highSimilarityNeutrals = neutralSimilarities.filter(item => item.similarity > 0.3);
  neutralPenalty = highSimilarityNeutrals.reduce((sum, item) => sum + (item.similarity * 50), 0);
  
  // Add highest similarity neutral words to dangerous list
  highSimilarityNeutrals
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3) // Just report the top 3 most similar neutrals
    .forEach(item => {
      dangerousWords.push(`NEUTRAL: ${item.word} (${(item.similarity * 100).toFixed(0)}%)`);
    });
  
  // Calculate the final score
  const score = teamWordScore + uniquenessBonus - assassinPenalty - opponentPenalty - neutralPenalty;
  
  // Apply a strong veto if the clue is objectively dangerous
  // If the top dangerous word has over 70% similarity, the clue is too risky
  const hasVeryDangerousWords = dangerousWords.some(warning => {
    const percentMatch = parseInt(warning.match(/\((\d+)%\)/)![1]);
    return percentMatch > 60; // If any word has >60% similarity, veto the clue
  });
  
  // Apply an extreme penalty for objectively dangerous clues
  const finalScore = hasVeryDangerousWords ? -1000 : score;
  
  // Return both the score and the detailed breakdown
  return {
    score: finalScore,
    details: {
      teamWordScore,
      assassinPenalty,
      opponentPenalty,
      neutralPenalty,
      uniquenessBonus,
      dangerousWords
    }
  };
}

// Semantic similarity matcher that uses known relationships between words
const SEMANTIC_RELATIONSHIPS: Record<string, string[]> = {
  // Celestial objects and space
  'celestial': ['sun', 'moon', 'star', 'planet', 'space', 'galaxy', 'orbit', 'sky', 'heaven', 'universe', 'cosmos', 'astronomical'],
  'space': ['moon', 'sun', 'star', 'planet', 'galaxy', 'rocket', 'nasa', 'astronaut', 'orbit', 'cosmos'],
  'sky': ['moon', 'sun', 'star', 'cloud', 'blue', 'heaven', 'bird', 'fly', 'air'],
  'astronomy': ['moon', 'sun', 'star', 'planet', 'telescope', 'galaxy', 'orbit'],
  'night': ['moon', 'star', 'dark', 'evening', 'sleep', 'dream', 'owl'],
  
  // Water and ocean
  'water': ['ocean', 'sea', 'lake', 'river', 'stream', 'pool', 'rain', 'wet', 'splash', 'swim', 'drink', 'flow', 'wave'],
  'ocean': ['sea', 'water', 'wave', 'beach', 'shore', 'island', 'ship', 'fish', 'shark', 'whale', 'deep', 'blue'],
  'sea': ['ocean', 'water', 'wave', 'beach', 'shore', 'island', 'ship', 'fish', 'shark', 'whale', 'deep', 'blue'],
  'liquid': ['water', 'drink', 'flow', 'pour', 'spill'],
  
  // Animals and nature
  'animal': ['dog', 'cat', 'bird', 'fish', 'lion', 'tiger', 'bear', 'wolf', 'horse', 'cow', 'pig', 'elephant', 'mouse', 'rat'],
  'nature': ['tree', 'flower', 'plant', 'animal', 'mountain', 'river', 'forest', 'green', 'earth', 'environment'],
  'wild': ['animal', 'jungle', 'forest', 'lion', 'tiger', 'bear', 'wolf', 'untamed', 'savage'],
  
  // Tech and computers
  'computer': ['screen', 'keyboard', 'mouse', 'program', 'code', 'software', 'hardware', 'internet', 'web', 'data', 'file'],
  'technology': ['computer', 'phone', 'internet', 'app', 'software', 'hardware', 'digital', 'electronic', 'device'],
  'digital': ['computer', 'binary', 'electronic', 'virtual', 'online', 'cyber', 'internet'],
  
  // Transportation
  'vehicle': ['car', 'truck', 'bus', 'train', 'plane', 'ship', 'boat', 'bicycle', 'motorcycle', 'drive', 'ride'],
  'travel': ['car', 'airplane', 'train', 'trip', 'vacation', 'journey', 'visit', 'explore', 'adventure'],
  'flight': ['airplane', 'airport', 'pilot', 'jet', 'wing', 'fly', 'sky', 'air'],
  
  // Food and dining
  'food': ['eat', 'meal', 'breakfast', 'lunch', 'dinner', 'restaurant', 'cook', 'kitchen', 'recipe', 'taste', 'flavor'],
  'fruit': ['apple', 'orange', 'banana', 'grape', 'berry', 'sweet', 'juice', 'tree'],
  'vegetable': ['carrot', 'potato', 'tomato', 'broccoli', 'green', 'salad', 'garden', 'plant'],
  
  // Games and sports
  'game': ['play', 'fun', 'board', 'card', 'video', 'sport', 'team', 'win', 'lose', 'score', 'competition'],
  'sport': ['play', 'game', 'team', 'ball', 'athlete', 'competition', 'win', 'lose', 'score', 'field', 'court'],
  'ball': ['sport', 'game', 'round', 'throw', 'catch', 'kick', 'bounce', 'play'],
  
  // Art and music
  'art': ['paint', 'draw', 'artist', 'museum', 'gallery', 'creative', 'design', 'color', 'sculpture'],
  'music': ['song', 'sound', 'rhythm', 'melody', 'instrument', 'band', 'concert', 'listen', 'hear', 'play'],
  'instrument': ['music', 'play', 'sound', 'band', 'orchestra', 'guitar', 'piano', 'drum', 'violin'],
  
  // Buildings and structures
  'building': ['house', 'office', 'skyscraper', 'apartment', 'structure', 'construct', 'architect', 'floor', 'roof', 'door', 'window'],
  'home': ['house', 'family', 'live', 'room', 'door', 'window', 'roof', 'comfort', 'safe'],
  'structure': ['building', 'bridge', 'tower', 'construct', 'form', 'shape', 'architecture'],
  
  // Time and events
  'time': ['clock', 'hour', 'minute', 'second', 'day', 'night', 'past', 'present', 'future', 'early', 'late'],
  'event': ['party', 'celebration', 'ceremony', 'festival', 'concert', 'meeting', 'conference', 'wedding'],
  'holiday': ['christmas', 'halloween', 'thanksgiving', 'celebration', 'vacation', 'trip', 'festive'],
  
  // Light and vision
  'light': ['bright', 'sun', 'lamp', 'shine', 'glow', 'dark', 'day', 'see', 'vision', 'flash'],
  'color': ['red', 'blue', 'green', 'yellow', 'rainbow', 'paint', 'bright', 'dark', 'shade', 'hue'],
  'dark': ['night', 'black', 'shadow', 'light', 'dim', 'blind'],
  
  // Weather and elements
  'weather': ['rain', 'snow', 'sun', 'wind', 'cloud', 'storm', 'temperature', 'hot', 'cold', 'warm', 'climate'],
  'temperature': ['hot', 'cold', 'warm', 'cool', 'heat', 'freeze', 'thermometer', 'degree', 'weather'],
  'fire': ['hot', 'burn', 'flame', 'heat', 'smoke', 'light', 'cook', 'camp', 'fireplace'],
  
  // Body and health
  'body': ['head', 'arm', 'leg', 'hand', 'foot', 'heart', 'blood', 'bone', 'skin', 'muscle', 'health'],
  'health': ['doctor', 'hospital', 'medicine', 'sick', 'well', 'disease', 'cure', 'healthy', 'exercise', 'diet'],
  'medical': ['doctor', 'hospital', 'nurse', 'medicine', 'health', 'patient', 'sick', 'disease', 'cure', 'treat'],
  
  // Military and conflict
  'military': ['army', 'navy', 'soldier', 'war', 'weapon', 'tank', 'gun', 'bomb', 'fight', 'battle', 'defense'],
  'war': ['battle', 'soldier', 'weapon', 'fight', 'enemy', 'army', 'victory', 'defeat', 'peace', 'military'],
  'weapon': ['gun', 'sword', 'knife', 'bomb', 'missile', 'military', 'war', 'fight', 'attack', 'defense'],
};

// More comprehensive semantic similarity estimator
function estimateWordSimilarity(word1: string, word2: string): number {
  word1 = word1.toLowerCase();
  word2 = word2.toLowerCase();
  
  // Direct match is worst case (1.0 similarity)
  if (word1 === word2) return 1.0;
  
  // Check semantic relationships first (most important)
  // This is a critical check to avoid dangerous clues like "celestial" leading to "moon"
  for (const [concept, relatedWords] of Object.entries(SEMANTIC_RELATIONSHIPS)) {
    // Check if one word is a concept and the other is in its related words
    if ((word1 === concept && relatedWords.includes(word2)) || 
        (word2 === concept && relatedWords.includes(word1))) {
      return 0.9; // Very high semantic relationship score
    }
    
    // Check if both words are in the same concept group
    if (relatedWords.includes(word1) && relatedWords.includes(word2)) {
      return 0.8; // High similarity for words in the same concept group
    }
  }
  
  // Check for word root similarities
  const root1 = word1.substring(0, Math.min(5, word1.length));
  const root2 = word2.substring(0, Math.min(5, word2.length));
  if (root1 === root2 && root1.length >= 4) {
    // Words share same root (e.g., "product" and "production")
    return 0.7;
  }
  
  // Check for prefix/suffix matches
  if (word1.startsWith(word2) || word2.startsWith(word1)) return 0.6;
  if (word1.endsWith(word2) || word2.endsWith(word1)) return 0.5;
  
  // Check for substring matches
  if (word1.includes(word2) || word2.includes(word1)) return 0.4;
  
  // Check for shared letters (weakest signal)
  const sharedLetters = [...new Set(word1.split(''))].filter(c => word2.includes(c));
  const uniqueLetters = [...new Set([...word1.split(''), ...word2.split('')])];
  const letterSimilarity = sharedLetters.length / uniqueLetters.length;
  
  return letterSimilarity * 0.3; // Scale down letter-based similarity
}

// Create a debounced version of the background thinking function
export const debouncedBackgroundThinking = debounce(backgroundSpymasterThinking, 5000, {
  leading: true,
  trailing: true,
  maxWait: 30000
});

// Export clients 
export { openai, anthropic, genAI };
export { getTeamMemory, updateDiscussionMemory, getActiveClues, updateTurnResults } from './game-memory';