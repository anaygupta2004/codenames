import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { type CardType } from "@shared/schema";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024
// the newest Anthropic model is "claude-3-5-sonnet-20241022" which was released October 22, 2024
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212";
type AIService = "openai" | "anthropic" | "xai";

export async function getSpymasterClue(
  model: AIModel,
  words: string[],
  teamWords: string[],
  opposingWords: string[],
  assassinWord: string
): Promise<{ word: string; number: number }> {
  const prompt = `As a Codenames spymaster, analyze these game elements:
Board words: ${words.join(", ")}
My team's words: ${teamWords.join(", ")}
Opposing team's words: ${opposingWords.join(", ")}
Assassin word: ${assassinWord}

Give a one-word clue and a number indicating how many words it relates to.
The clue must follow Codenames rules:
- Must be a single word
- Cannot be any form of the visible words
- Should connect multiple team words if possible
- Avoid leading to opponent or assassin words

Respond in JSON format: { "word": "clue", "number": count }`;

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
  revealedCards: string[]
): Promise<string> {
  const availableWords = words.filter(word => !revealedCards.includes(word));

  const prompt = `As a Codenames guesser, analyze:
Available words: ${availableWords.join(", ")}
Clue word: ${clue.word}
Clue number: ${clue.number}

Choose the word that best matches the clue.
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

function getAIService(model: AIModel): AIService {
  if (model === "gpt-4o") return "openai";
  if (model === "claude-3-5-sonnet-20241022") return "anthropic";
  if (model === "grok-2-1212") return "xai";
  throw new Error("Invalid AI model");
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
