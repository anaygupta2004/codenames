import { type Game, type CardType, type AIModel } from "@shared/schema";

export function generateGameWords(): string[] {
  const words = [
    "APPLE", "BANK", "CAR", "DOG", "EAGLE", "FIRE", "GOLD", "HORSE",
    "ICE", "JACKET", "KING", "LAMP", "MOON", "NIGHT", "OCEAN", "PARK",
    "QUEEN", "RAIN", "STAR", "TIME", "WATER", "WIND", "YARD", "ZEBRA", "TREE"
  ];
  return shuffleArray(words);
}

export function createInitialGame(
  redSpymasterAI: boolean, 
  blueSpymasterAI: boolean,
  redAIModel: AIModel = "gpt-4o",
  blueAIModel: AIModel = "claude-3-5-sonnet-20241022"
): Omit<Game, "id"> {
  const words = generateGameWords();
  const assignments = assignCards();

  return {
    words,
    redTeam: words.filter((_, i) => assignments[i] === "red"),
    blueTeam: words.filter((_, i) => assignments[i] === "blue"),
    neutralWords: words.filter((_, i) => assignments[i] === "neutral"),
    assassin: words[assignments.findIndex(type => type === "assassin")],
    currentTurn: Math.random() < 0.5 ? "red_turn" : "blue_turn",
    redScore: 0,
    blueScore: 0,
    gameState: "red_turn",
    redSpymaster: redSpymasterAI,
    blueSpymaster: blueSpymasterAI,
    redAIModel,
    blueAIModel,
    revealedCards: [],
  };
}

function assignCards(): CardType[] {
  const cards: CardType[] = [
    ...Array(8).fill("red"),
    ...Array(8).fill("blue"),
    ...Array(7).fill("neutral"),
    ...Array(1).fill("assassin")
  ];
  return shuffleArray(cards);
}

function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}