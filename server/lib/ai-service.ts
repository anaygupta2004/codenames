import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { type CardType, type GameHistoryEntry, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024
// the newest Anthropic model is "claude-3-5-sonnet-20241022" which was released October 22, 2024
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY || '');

export type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212" | "gemini-pro";
export type AIService = "openai" | "anthropic" | "xai" | "google";

const VALID_MODELS = ["gpt-4o", "claude-3-5-sonnet-20241022", "grok-2-1212", "gemini-pro"];

function validateModel(model: string): AIModel {
  if (!VALID_MODELS.includes(model)) {
    throw new Error(`Invalid AI model: ${model}. Valid models are: ${VALID_MODELS.join(", ")}`);
  }
  return model as AIModel;
}

function getAIService(model: AIModel): AIService {
  if (model === "gpt-4o") return "openai";
  if (model === "claude-3-5-sonnet-20241022") return "anthropic";
  if (model === "grok-2-1212") return "xai";
  if (model === "gemini-pro") return "google";
  throw new Error(`Invalid AI model: ${model}`);
}

// Add Gemini functions
async function getGeminiClue(prompt: string): Promise<{ word: string; number: number }> {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const response = result.response;
    const text = response.text();

    try {
      const parsed = JSON.parse(text);
      if (!parsed.word || typeof parsed.number !== 'number') {
        throw new Error("Invalid response format");
      }
      return parsed;
    } catch (error) {
      console.error("Error parsing Gemini response:", error);
      throw new Error("Failed to parse Gemini response");
    }
  } catch (error) {
    console.error("Error in Gemini clue generation:", error);
    throw new Error("Failed to generate clue with Gemini");
  }
}

async function getGeminiGuess(prompt: string): Promise<{ guess: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const response = result.response;
    const text = response.text().trim();

    try {
      const parsed = JSON.parse(text);
      if (!parsed.guess || typeof parsed.guess !== 'string') {
        throw new Error("Invalid response format");
      }
      return parsed;
    } catch (error) {
      console.error("Error parsing Gemini guess response:", error);
      throw new Error("Failed to parse Gemini guess response");
    }
  } catch (error) {
    console.error("Error in Gemini guess generation:", error);
    throw new Error("Failed to generate guess with Gemini");
  }
}

async function getGeminiDiscussion(prompt: string): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const response = result.response;
    const text = response.text().trim();

    try {
      const parsed = JSON.parse(text);
      if (!parsed.message || typeof parsed.confidence !== 'number') {
        throw new Error("Invalid response format");
      }
      return {
        message: parsed.message,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        suggestedWord: parsed.suggestedWord
      };
    } catch (error) {
      console.error("Error parsing Gemini discussion response:", error);
      return {
        message: "I encountered an error processing the response. Let's proceed with the team's consensus.",
        confidence: 0.5
      };
    }
  } catch (error) {
    console.error("Error in Gemini discussion:", error);
    return {
      message: "I encountered a technical issue. Let's continue our discussion based on the team's input.",
      confidence: 0.5
    };
  }
}

async function getGeminiVote(prompt: string): Promise<{ approved: boolean; reason: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const response = result.response;
    const text = response.text().trim();

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.approved !== 'boolean' || typeof parsed.reason !== 'string') {
        throw new Error("Invalid response format");
      }
      return parsed;
    } catch (error) {
      console.error("Error parsing Gemini vote response:", error);
      return {
        approved: false,
        reason: "Due to technical issues, I'm abstaining from this vote."
      };
    }
  } catch (error) {
    console.error("Error in Gemini vote:", error);
    return {
      approved: false,
      reason: "Unable to process voting decision due to technical issues."
    };
  }
}

// Update the main functions to include Gemini
const GAME_RULES = `
Codenames Rules:
1. The board has 25 words - some belong to red team, some to blue team, some are neutral, and one is the assassin
2. Each team's spymaster knows which words belong to which team
3. The spymaster gives a one-word clue and a number indicating how many words relate to that clue
4. Team members can make multiple guesses for a clue if they're confident
5. If a wrong word is guessed, the turn ends immediately
6. Guessing the assassin word loses the game instantly
7. First team to find all their words wins
8. Strategic elements:
   - Try to connect multiple words with one clue
   - Be careful to avoid clues that might lead to opponent words or assassin
   - Consider the risk/reward of multiple guesses
   - Track opponent clues to avoid their words`;

export async function getSpymasterClue(
  model: string | AIModel,
  words: string[],
  teamWords: string[],
  opposingWords: string[],
  assassinWord: string,
  gameHistory: GameHistoryEntry[]
): Promise<{ word: string; number: number }> {
  const validatedModel = validateModel(model as string);

  // Filter active clues (clues with remaining unguessed words)
  const activeClues = gameHistory
    .filter(entry => entry.type === "clue")
    .map(clueEntry => {
      const relatedGuesses = gameHistory
        .filter(g => g.type === "guess" && g.relatedClue === clueEntry.content);
      const guessedWords = new Set(relatedGuesses.map(g => g.word));
      const remainingWords = teamWords.filter(w => !guessedWords.has(w));
      return {
        clue: clueEntry.content,
        remainingWords
      };
    })
    .filter(clue => clue.remainingWords.length > 0);

  const prompt = `${GAME_RULES}

As the ${model === "red_spymaster" ? "Red" : "Blue"} team's spymaster, analyze the game state:

Board Configuration:
- Your team's remaining words: ${teamWords.join(", ")}
- Opposing team's words (avoid these): ${opposingWords.join(", ")}
- Assassin word (critical to avoid): ${assassinWord}
- All board words: ${words.join(", ")}

Game State:
- Active clues with unguessed words: ${activeClues.length > 0 
  ? activeClues.map(c => `"${c.clue}" (${c.remainingWords.length} words remaining)`).join(", ")
  : "None"}
- Previous guesses and results: ${gameHistory
    .filter(entry => entry.type === "guess")
    .map(entry => `${entry.word} (${entry.result})`).join(", ")}

Strategic Objectives:
1. Create efficient clues linking multiple words when possible
2. Avoid clues that could lead to opponent words or assassin
3. Consider the current game state and which team is ahead
4. Try to build on previous successful clues if applicable

Provide your clue in JSON format: { "word": "clue", "number": count }`;

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

// Updated guesser move function with strategic context
export async function getGuesserMove(
  model: AIModel,
  words: string[],
  clue: { word: string; number: number },
  revealedCards: string[],
  gameHistory: GameHistoryEntry[]
): Promise<string> {
  const availableWords = words.filter(word => !revealedCards.includes(word));

  const currentTeam = gameHistory[gameHistory.length - 1]?.turn || "red";
  const teamHistory = gameHistory.filter(entry => entry.turn === currentTeam);

  // Track active clues and their unguessed words
  const activeClues = teamHistory
    .filter(entry => entry.type === "clue")
    .map(clueEntry => {
      const relatedGuesses = teamHistory
        .filter(g => g.type === "guess" && g.relatedClue === clueEntry.content);
      return {
        clue: clueEntry.content,
        guessedWords: relatedGuesses.map(g => g.word),
        result: relatedGuesses.map(g => g.result)
      };
    });

  const prompt = `${GAME_RULES}

As a Codenames operative, analyze the current game situation:

Current State:
- Available words: ${availableWords.join(", ")}
- Current clue: "${clue.word}" (looking for ${clue.number} words)
- Revealed words: ${revealedCards.join(", ")}

Team History:
${activeClues.map(c => 
  `Clue "${c.clue}": ${c.guessedWords.length > 0 
    ? `Guesses: ${c.guessedWords.map((w, i) => `${w} (${c.result[i]})`).join(", ")}` 
    : "No guesses yet"}`
).join("\n")}

Strategy Tips:
1. Consider previous guess results to inform your decision
2. If uncertain about a word, save it for later rounds
3. Look for strong connections to the current clue
4. Be cautious of words that might be opponent's or assassin
5. Consider the risk/reward of guessing when uncertain

Choose one unrevealed word that best matches the clue.
Respond in JSON format: { "guess": "chosen_word" }`;

  switch (getAIService(model)) {
    case "openai":
      return (await getOpenAIGuess(prompt)).guess;
    case "anthropic":
      return (await getAnthropicGuess(prompt)).guess;
    case "xai":
      return (await getXAIGuess(prompt)).guess;
    case "google":
      return (await getGeminiGuess(prompt)).guess;
    default:
      throw new Error("Invalid AI model");
  }
}

// Updated discussion function with strategic context
export async function discussAndVote(
  model: AIModel,
  team: "red" | "blue",
  words: string[],
  clue: { word: string; number: number } | undefined,
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  revealedCards: string[]
): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  if (!clue || !clue.word || typeof clue.number !== 'number') {
    throw new Error("Invalid clue format provided to discussAndVote");
  }

  const availableWords = words.filter(word => !revealedCards.includes(word));
  const teamHistory = gameHistory.filter(entry => entry.turn === team);

  // Track clue success rates
  const cluePerformance = teamHistory
    .filter(entry => entry.type === "clue")
    .map(clueEntry => {
      const relatedGuesses = teamHistory
        .filter(g => g.type === "guess" && g.relatedClue === clueEntry.content);
      const successRate = relatedGuesses.filter(g => g.result === "correct").length / relatedGuesses.length;
      return {
        clue: clueEntry.content,
        successRate: isNaN(successRate) ? 0 : successRate,
        guesses: relatedGuesses.map(g => `${g.word} (${g.result})`)
      };
    });

  // Sort discussions by timestamp to show the conversation flow
  const recentTeamDiscussion = teamDiscussion
    .filter(entry => entry.team === team)
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(entry => {
      const modelInfo = getModelInfo(entry.player as AIModel);
      return `${modelInfo.name} (${modelInfo.service}): ${entry.message} ${
        entry.suggestedWord ? `[Suggests: ${entry.suggestedWord}]` : ''
      } (confidence: ${entry.confidence})`;
    })
    .join("\n");

  const prompt = `${GAME_RULES}

Current Game Discussion:
Team: ${team}
Current Clue: "${clue.word}" (looking for ${clue.number} words)
Available Words: ${availableWords.join(", ")}

Team Performance:
${cluePerformance.map(c => 
  `Clue "${c.clue}": Success rate ${(c.successRate * 100).toFixed(1)}%
   Guesses: ${c.guesses.join(", ")}`
).join("\n")}

Recent Team Discussion:
${recentTeamDiscussion}

As ${getModelDisplayName(model)}, contribute to the team discussion:
1. Analyze previous guesses and their results
2. Consider teammates' suggestions and confidence levels
3. Evaluate the risk/reward of available words
4. Share strategic insights about the current clue
5. If highly confident (>0.7), suggest a specific word

Respond in JSON format: {
  "message": "your analysis and strategic thoughts",
  "confidence": number between 0-1,
  "suggestedWord": "word_choice" // Only if confidence > 0.7
}`;

  switch (getAIService(model)) {
    case "openai":
      return await getOpenAIDiscussion(prompt);
    case "anthropic":
      return await getAnthropicDiscussion(prompt);
    case "xai":
      return await getXAIDiscussion(prompt);
    case "google":
      return await getGeminiDiscussion(prompt);
    default:
      throw new Error("Invalid AI model");
  }
}

export async function makeConsensusVote(
  model: AIModel,
  team: "red" | "blue",
  proposedWord: string,
  teamDiscussion: TeamDiscussionEntry[],
): Promise<{ approved: boolean; reason: string }> {
  const recentDiscussion = teamDiscussion
    .filter(entry => entry.team === team)
    .map(entry => `${entry.player}: ${entry.message} (confidence: ${entry.confidence})`)
    .join("\n");

  const prompt = `As a Codenames AI player, decide whether to approve the proposed guess:

Proposed word: ${proposedWord}

Team Discussion:
${recentDiscussion}

Consider:
1. Team consensus level
2. Confidence scores
3. Potential risks

Respond in JSON format: { "approved": boolean, "reason": "explanation of your decision" }`;

  switch (getAIService(model)) {
    case "openai":
      return await getOpenAIVote(prompt);
    case "anthropic":
      return await getAnthropicVote(prompt);
    case "xai":
      return await getXAIVote(prompt);
    case "google":
      return await getGeminiVote(prompt);
    default:
      throw new Error("Invalid AI model");
  }
}

async function getOpenAIClue(prompt: string): Promise<{ word: string; number: number }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  const result = JSON.parse(content) as { word: string; number: number };
  if (!result.word || typeof result.number !== 'number') {
    throw new Error("Invalid response format from OpenAI");
  }

  return result;
}

async function getAnthropicClue(prompt: string): Promise<{ word: string; number: number }> {
  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  const content = response.content[0].text;
  const result = JSON.parse(content) as { word: string; number: number };

  if (!result.word || typeof result.number !== 'number') {
    throw new Error("Invalid response format from Anthropic");
  }

  return result;
}

async function getXAIClue(prompt: string): Promise<{ word: string; number: number }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-2-1212",
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
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  return JSON.parse(response.content[0].text) as { guess: string };
}

async function getXAIGuess(prompt: string): Promise<{ guess: string }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-2-1212",
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
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text;
    return JSON.parse(content) as { message: string; confidence: number; suggestedWord?: string };
  } catch (error) {
    console.error("Error parsing Anthropic response:", error);
    // Provide a fallback response if JSON parsing fails
    return {
      message: "I encountered an error processing the response. Let's continue our discussion.",
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
    model: "grok-2-1212",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return JSON.parse(content) as { message: string; confidence: number; suggestedWord?: string };
}

async function getOpenAIVote(prompt: string): Promise<{ approved: boolean; reason: string }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return JSON.parse(content) as { approved: boolean; reason: string };
}

async function getAnthropicVote(prompt: string): Promise<{ approved: boolean; reason: string }> {
  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  if (!response.content[0] || response.content[0].type !== 'text') {
    throw new Error("Invalid response format from Anthropic");
  }

  try {
    const content = response.content[0].text;
    return JSON.parse(content) as { approved: boolean; reason: string };
  } catch (error) {
    console.error("Error parsing Anthropic vote response:", error);
    // Provide a fallback response if JSON parsing fails
    return {
      approved: false,
      reason: "Could not process the voting decision due to an error."
    };
  }
}

async function getXAIVote(prompt: string): Promise<{ approved: boolean; reason: string }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY
  });

  const response = await openaiXAI.chat.completions.create({
    model: "grok-2-1212",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from xAI");
  }

  return JSON.parse(content) as { approved: boolean; reason: string };
}

// Helper function for consistent model display names
function getModelDisplayName(model: AIModel): string {
  switch (model) {
    case "gpt-4o":
      return "GPT-4";
    case "claude-3-5-sonnet-20241022":
      return "Claude";
    case "grok-2-1212":
      return "Grok";
    case "gemini-pro":
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