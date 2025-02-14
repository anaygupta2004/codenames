import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { type CardType, type GameHistoryEntry, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024
// the newest Anthropic model is "claude-3-5-sonnet-20241022" which was released October 22, 2024
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212";
type AIService = "openai" | "anthropic" | "xai";

export async function discussAndVote(
  model: AIModel,
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

  const prompt = `As a Codenames AI player, analyze the team discussion:

Current clue: "${clue.word}" (${clue.number})
Available words: ${availableWords.join(", ")}

Team Discussion:
${recentDiscussion}

Game History:
${previousCluesAndResults}

1. Analyze the other team members' suggestions
2. Consider their confidence levels
3. State your opinion about the best word choice
4. Express your confidence level (0-1)
5. If you disagree with others, explain why

Respond in JSON format: { "message": "your detailed analysis", "confidence": number }`;

  switch (getAIService(model)) {
    case "openai":
      return await getOpenAIDiscussion(prompt);
    case "anthropic":
      return await getAnthropicDiscussion(prompt);
    case "xai":
      return await getXAIDiscussion(prompt);
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
    default:
      throw new Error("Invalid AI model");
  }
}

export async function getSpymasterClue(
  model: AIModel,
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

  const prompt = `As a Codenames spymaster, analyze these game elements:
Board words: ${words.join(", ")}
My team's words: ${teamWords.join(", ")}
Opposing team's words: ${opposingWords.join(", ")}
Assassin word: ${assassinWord}

Game History:
Previous clues given: ${previousClues || "None"}
Previous guesses made: ${previousGuesses || "None"}

Give a one-word clue and a number indicating how many words it relates to.
Consider previous clues and guesses to avoid repetition and learn from mistakes.
Respond in JSON format: { "word": "clue", "number": count }
The clue must follow Codenames rules:
- Must be a single word
- Cannot be any form of the visible words
- Should connect multiple team words if possible
- Avoid words that might lead to opponent or assassin words
- Avoid words similar to previously failed clues`;

  switch (getAIService(model)) {
    case "openai":
      return await getOpenAIClue(prompt);
    case "anthropic":
      return await getAnthropicClue(prompt);
    case "xai":
      return await getXAIClue(prompt);
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

  const prompt = `As a Codenames guesser, analyze:
Available words: ${availableWords.join(", ")}
Current clue word: ${clue.word}
Current clue number: ${clue.number}

Game History:
${previousCluesAndResults}

Choose the word that best matches the clue, considering:
1. Previous successful and failed guesses
2. Pattern of clues given
3. Words that remain unrevealed

Respond in JSON format: { "guess": "chosen_word" }`;

  switch (getAIService(model)) {
    case "openai":
      return (await getOpenAIGuess(prompt)).guess;
    case "anthropic":
      return (await getAnthropicGuess(prompt)).guess;
    case "xai":
      return (await getXAIGuess(prompt)).guess;
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

async function getOpenAIDiscussion(prompt: string): Promise<{ message: string; confidence: number }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  return JSON.parse(content) as { message: string; confidence: number };
}

async function getAnthropicDiscussion(prompt: string): Promise<{ message: string; confidence: number }> {
  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(response.content[0].text) as { message: string; confidence: number };
}

async function getXAIDiscussion(prompt: string): Promise<{ message: string; confidence: number }> {
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

  return JSON.parse(content) as { message: string; confidence: number };
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

  return JSON.parse(response.content[0].text) as { approved: boolean; reason: string };
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

function getAIService(model: AIModel): AIService {
  if (model === "gpt-4o") return "openai";
  if (model === "claude-3-5-sonnet-20241022") return "anthropic";
  if (model === "grok-2-1212") return "xai";
  throw new Error("Invalid AI model");
}