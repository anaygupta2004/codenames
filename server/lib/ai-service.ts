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
export async function getSpymasterClue(
  model: string | AIModel,
  words: string[],
  teamWords: string[],
  opposingWords: string[],
  assassinWord: string,
  gameHistory: GameHistoryEntry[]
): Promise<{ word: string; number: number }> {
  const validatedModel = validateModel(model as string);

  const previousClues = gameHistory
    .filter(entry => entry.type === "clue")
    .map(entry => entry.content)
    .join(", ");

  const previousGuesses = gameHistory
    .filter(entry => entry.type === "guess")
    .map(entry => `${entry.content} (${entry.result})`)
    .join(", ");

  const prompt = `As a Codenames spymaster, you must follow these strict rules:
1. Give exactly ONE one-word clue and a number indicating how many words it relates to
2. The clue cannot be any form/part/variation of the visible words
3. Cannot use proper nouns, abbreviations, or made-up words
4. Never reveal which specific words are your team's words
5. Carefully avoid words that might lead to opponent or assassin words

Board words: ${words.join(", ")}
My team's words: ${teamWords.join(", ")}
Opposing team's words: ${opposingWords.join(", ")}
Assassin word: ${assassinWord}

Game History:
Previous clues given: ${previousClues || "None"}
Previous guesses made: ${previousGuesses || "None"}

Give your clue following these rules in JSON format: { "word": "clue", "number": count }`;

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

export async function getGuesserMove(
  model: AIModel,
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

  const prompt = `As a Codenames operative, follow these strict rules:
1. You can only guess from unrevealed words
2. You must consider the current clue carefully
3. Avoid words that might be the assassin
4. Learn from previous guesses and their results

Available unrevealed words: ${availableWords.join(", ")}
Current clue word: ${clue.word}
Current clue number: ${clue.number}
Already revealed words: ${revealedCards.join(", ")}

Game History:
${previousCluesAndResults}

Choose one unrevealed word that best matches the clue.
Respond in JSON format: { "guess": "chosen_word" }

Note: Your guess must be one of the unrevealed available words!`;

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

export async function discussAndVote(
  model: AIModel,
  team: "red" | "blue",
  words: string[],
  clue: { word: string; number: number } | undefined,
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  revealedCards: string[],
): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  if (!clue || !clue.word || typeof clue.number !== 'number') {
    throw new Error("Invalid clue format provided to discussAndVote");
  }

  const availableWords = words.filter(word => !revealedCards.includes(word));

  // Filter discussions to only include current team's discussion
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

  // Extract relevant game history for informed decisions
  const relevantHistory = gameHistory
    .filter(entry => {
      // Include all clues for context
      if (entry.type === "clue") return true;
      // For guesses, only include the team's own guesses and their results
      if (entry.type === "guess") return entry.turn === team;
      return false;
    })
    .map(entry => {
      if (entry.type === "clue") return `Clue: ${entry.content}`;
      return `Our guess: ${entry.content} (${entry.result})`;
    })
    .join("\n");

  const prompt = `As a Codenames AI player on the ${team} team, analyze the situation:

Current Game State:
- Current clue: "${clue.word}" (${clue.number})
- Available unrevealed words: ${availableWords.join(", ")}
- Words we've revealed: ${revealedCards.filter(word => gameHistory.some(h => h.turn === team && h.content === word)).join(", ")}

Your Team's Discussion:
${recentTeamDiscussion}

Your Team's History:
${relevantHistory}

As ${getModelDisplayName(model)}, carefully consider:
1. The current clue and how it relates to unrevealed words
2. Your teammates' suggestions and their confidence levels
3. Previous successful and unsuccessful guesses by your team
4. Avoid words that have already been revealed
5. Express your confidence level (0-1)
6. Suggest a word only if you're confident (>0.7)

Respond in JSON format: { 
  "message": "your detailed analysis",
  "confidence": number,
  "suggestedWord": "word_choice"  // Only include if confidence > 0.7
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