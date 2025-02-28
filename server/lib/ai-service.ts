import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { b } from '../../baml_client'
import { type GameHistoryEntry, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";


let openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy-key-for-dev'
});

let anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'dummy-key-for-dev'
});

let genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'dummy-key-for-dev');

export type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212" | "gemini-1.5-pro";
export type AIService = "openai" | "anthropic" | "xai" | "google";

const VALID_MODELS = ["gpt-4o", "claude-3-5-sonnet-20241022", "grok-2-1212", "gemini-1.5-pro"];

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
): Promise<{ word: string; number: number; reasoning?: string }> {
  const validatedModel = validateModel(model as string);

// Filter active clues (clues with remaining unguessed words)
  const activeClues = gameHistory
    .filter(entry => entry.type === "clue" && entry.content)
    .map(clueEntry => {
      const relatedGuesses = gameHistory
        .filter(g => g.type === "guess" && g.relatedClue === clueEntry.content);
      const guessedWords = new Set(relatedGuesses.map(g => g.word || ''));
      const remainingWords = teamWords.filter(w => !guessedWords.has(w));
      return {
        clue: clueEntry.content,
        remainingWords
      };
    })
    .filter(clue => clue.remainingWords.length > 0);

  const prompt = `${GAME_RULES}

As the spymaster, analyze the game state:

Board Configuration:
- Your team's remaining words: ${teamWords.join(", ")}
- Opposing team's words (avoid these): ${opposingWords.join(", ")}
- Assassin word (critical to avoid): ${assassinWord}
- All board words: ${words.join(", ")}

Game State:
- Active clues with unguessed words: ${activeClues.length > 0
    ? activeClues.map(c => `"${c.clue}" (${c.remainingWords.length} words remaining)`).join(", ")
    : "None"}

Strategic Objectives:
1. Prioritize clues that connect multiple words efficiently
2. Consider word relationships and semantic connections
3. Balance risk vs reward based on game state
4. Build on previous successful clue patterns
5. Consider the current score and adjust strategy accordingly


Make sure to consider the words that have already been guessed and the words that are still available. 
Be sure to consider the words that are opposing team words, neutral words, and the assassin word. 

Think very deeply about your choice. DO NOT GIVE CLUE THAT IS ASSOCIATED WITH THE ASSASSIN WORD & ALREADY GUESSED WORDS & OPPONENTS WORDS.

Provide your clue in JSON format: { "word": "clue", "number": count "reasoning": "your reasoning for your choice" }`;

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
  clue: { word: string; number: number },
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  revealedCards: string[]
): Promise<{ message: string; confidence: number; suggestedWord?: string }> {
  // Get recent game context
  const recentClues = gameHistory
    .filter(h => h.type === 'clue')
    .slice(-3)
    .map(h => h.content);

  const recentDiscussion = teamDiscussion
    .slice(-5)
    .map(d => `${d.player}: ${d.message}`)
    .join('\n');

  const availableWords = words.filter(w => !revealedCards.includes(w));

  const prompt = `You are playing Codenames as a ${team} team player.
Your team received the clue: "${clue.word}" (${clue.number})

Game Context:
- Previous clues: ${recentClues.join(', ')}
- Available words: ${availableWords.join(', ')}
- Words revealed so far: ${revealedCards.join(', ')}

Recent team discussion:
${recentDiscussion}

As an AI player, engage in natural discussion with your teammates about the clue.
Consider:
1. How the current clue might connect to multiple words
2. What previous clues and guesses tell us about word associations
3. The risk level of each potential guess
4. Strategic implications (e.g., avoiding opponent's words)

Respond as a helpful teammate would, explaining your reasoning naturally.
Include JSON with your analysis: {
  "message": "your conversational response",
  "confidence": number between 0-1,
  "suggestedWord": "your suggested word if confident"
}`;

  switch (model) {
    case "gpt-4o":
      return await getOpenAIDiscussion(prompt);
    case "claude-3-5-sonnet-20241022":
      return await getAnthropicDiscussion(prompt);
    case "grok-2-1212":
      return await getXAIDiscussion(prompt);
    case "gemini-1.5-pro":
      return await getGeminiDiscussion(prompt);
    default:
      throw new Error(`Invalid AI model: ${model}`);
  }
}

// Helper to format discussion messages more naturally
export function formatDiscussionMessage(
  model: AIModel,
  message: string,
  confidence: number,
  suggestedWord?: string
): string {
  const displayName = getModelDisplayName(model);
  let formattedMsg = message;

  if (suggestedWord && confidence > 0.7) {
    formattedMsg += ` I suggest "${suggestedWord}" (${(confidence * 100).toFixed(0)}% confident)`;
  } else if (suggestedWord) {
    formattedMsg += ` Maybe "${suggestedWord}"? (${(confidence * 100).toFixed(0)}% confident)`;
  }

  return formattedMsg;
}

export async function makeConsensusVote(
  model: AIModel,
  team: "red" | "blue",
  word: string,
  teamDiscussion: TeamDiscussionEntry[]
): Promise<{ approved: boolean; reason: string }> {
  const prompt = `You are playing Codenames. The team is discussing whether to guess "${word}".
Team discussion: ${JSON.stringify(teamDiscussion)}

Should we guess this word? Respond in JSON format with:
{
  "approved": boolean,
  "reason": "explanation for your decision"
}`;

  switch (model) {
    case "gpt-4o":
      return await getOpenAIVote(prompt);
    case "claude-3-5-sonnet-20241022":
      return await getAnthropicVote(prompt);
    case "grok-2-1212":
      return await getXAIVote(prompt);
    case "gemini-1.5-pro":
      return await getGeminiVote(prompt);
    default:
      throw new Error(`Invalid AI model: ${model}`);
  }
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
    model: "claude-3-5-sonnet-20241022",
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

    const result = JSON.parse(jsonMatch[0]);
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
    apiKey: "***REMOVED***"
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
    apiKey: "***REMOVED***"
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
    apiKey: "***REMOVED***"
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
    messages: [
      { 
        role: 'assistant', 
        content: 'You are a Codenames AI assistant that MUST ONLY respond with valid JSON objects containing "approved" and "reason" fields. Never include explanations outside of the JSON.' 
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
        reason: "Could not process voting decision due to response format error."
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    if (typeof result.approved !== 'boolean' || typeof result.reason !== 'string') {
      return {
        approved: false,
        reason: "Could not process voting decision due to invalid response format."
      };
    }

    return result;
  } catch (error) {
    console.error("Error parsing Anthropic vote response:", error);
    return {
      approved: false,
      reason: "Could not process the voting decision due to an error."
    };
  }
}

async function getXAIVote(prompt: string): Promise<{ approved: boolean; reason: string }> {
  const openaiXAI = new OpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: "***REMOVED***"
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

// Export only the clients that aren't already exported
export { openai, anthropic, genAI };