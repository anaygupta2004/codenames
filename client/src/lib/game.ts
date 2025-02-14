import { type Game, type CardType } from "@shared/schema";

export function generateGameWords(): string[] {
  const words = [
    "APPLE", "BANK", "CAR", "DOG", "EAGLE", "FIRE", "GOLD", "HORSE",
    "ICE", "JACKET", "KING", "LAMP", "MOON", "NIGHT", "OCEAN", "PARK",
    "QUEEN", "RAIN", "STAR", "TIME", "WATER", "WIND", "YARD", "ZEBRA", "TREE"
  ];
  return shuffleArray(words);
}

export function createInitialGame(redSpymasterAI: boolean, blueSpymasterAI: boolean): Omit<Game, "id"> {
  const words = generateGameWords();
  const assignments = assignCards();
  
  return {
    words,
    redTeam: assignments.filter((type) => type === "red").map((_, i) => words[i]),
    blueTeam: assignments.filter((type) => type === "blue").map((_, i) => words[i]),
    assassin: words[assignments.findIndex((type) => type === "assassin")],
    currentTurn: Math.random() < 0.5 ? "red_turn" : "blue_turn",
    redScore: 0,
    blueScore: 0,
    gameState: "red_turn",
    redSpymaster: redSpymasterAI,
    blueSpymaster: blueSpymasterAI,
    revealedCards: [],
    aiModel: "gpt-4o"
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
