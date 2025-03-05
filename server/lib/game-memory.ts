/**
 * Game Memory System
 * 
 * This module provides persistent memory for AI agents in the Codenames game.
 * It tracks game state, discussion history, and strategic information across 
 * turns to enable more human-like gameplay.
 */

import type { 
  Game, 
  GameHistoryEntry, 
  TeamDiscussionEntry, 
  GameState,
  RiskLevel,
  ConsensusLevel
} from "@shared/schema";
import type { AIModel } from "./ai-service";

// Define important types for game memory
export interface WordAssociation {
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
  isTeamWord?: boolean;
  isOpponentWord?: boolean;
  isNeutralWord?: boolean;
  isAssassin?: boolean;
}

export interface ClueMemory {
  clue: string;
  number: number; 
  timestamp: number;
  suggestedWords: WordAssociation[];
  guessedWords: string[];
  remainingGuesses: number;
  success: boolean;
  failure: boolean;
}

export interface ConflictMemory {
  wordA: string;
  wordB: string;
  agentA: string;
  agentB: string;
  resolved: boolean;
  resolvedBy?: string;
  resolution?: string;
  timestamp: number;
}

export interface DiscussionRound {
  round: number;
  timestamp: number;
  wordSuggestions: string[];
  conflicts: ConflictMemory[];
  consensus?: {
    reached: boolean;
    word?: string;
    supportLevel: ConsensusLevel;
    supporters: string[];
    opposers: string[];
  };
}

export interface TeamGameMemory {
  // Current game state
  teamWords: string[];
  opponentWords: string[];
  revealedCards: string[];
  assassinWord: string;
  gameScore: { red: number; blue: number };
  currentTeam: "red" | "blue";
  
  // Strategic memory
  activeClues: Map<string, ClueMemory>;
  wordAssociations: Map<string, WordAssociation[]>;
  discussionHistory: DiscussionRound[];
  
  // Gameplay statistics
  correctGuesses: number;
  incorrectGuesses: number;
  successfulClues: ClueMemory[];
  failedClues: ClueMemory[];
  
  // Game time tracking
  lastUpdateTime: number;
  gameStartTime: number;
  
  // Agent memory
  agentPersonalities: Map<string, {
    riskTolerance: "conservative" | "balanced" | "aggressive";
    wordAssociations: Map<string, string[]>;
    agreementWith: Map<string, number>; // How often this agent agrees with others
  }>;
}

// Global memory store for all games
const gameMemory = new Map<number, {
  red: TeamGameMemory;
  blue: TeamGameMemory;
}>();

/**
 * Initializes or retrieves memory for a specific team in a game
 */
export function getTeamMemory(gameId: number, team: "red" | "blue"): TeamGameMemory {
  // Initialize game memory if it doesn't exist
  if (!gameMemory.has(gameId)) {
    gameMemory.set(gameId, {
      red: createEmptyTeamMemory(),
      blue: createEmptyTeamMemory()
    });
  }
  
  return gameMemory.get(gameId)![team];
}

/**
 * Creates an empty team memory structure
 */
function createEmptyTeamMemory(): TeamGameMemory {
  return {
    teamWords: [],
    opponentWords: [],
    revealedCards: [],
    assassinWord: "",
    gameScore: { red: 0, blue: 0 },
    currentTeam: "red",
    
    activeClues: new Map(),
    wordAssociations: new Map(),
    discussionHistory: [],
    
    correctGuesses: 0,
    incorrectGuesses: 0,
    successfulClues: [],
    failedClues: [],
    
    lastUpdateTime: Date.now(),
    gameStartTime: Date.now(),
    
    agentPersonalities: new Map()
  };
}

/**
 * Updates team memory with the latest game state
 */
export function syncTeamMemoryWithGame(gameId: number, game: Game): void {
  console.log(`🔄 Syncing memory for game ${gameId} with latest state`);
  
  // Update red team memory
  const redMemory = getTeamMemory(gameId, "red");
  updateTeamWords(redMemory, game, "red");
  
  // Update blue team memory
  const blueMemory = getTeamMemory(gameId, "blue");
  updateTeamWords(blueMemory, game, "blue");
  
  // Common updates for both teams
  [redMemory, blueMemory].forEach(memory => {
    memory.revealedCards = game.revealedCards || [];
    memory.assassinWord = game.assassin;
    memory.gameScore = { red: game.redScore || 0, blue: game.blueScore || 0 };
    memory.currentTeam = game.currentTurn.startsWith("red") ? "red" : "blue";
    memory.lastUpdateTime = Date.now();
  });
  
  // Process game history to update strategic memory
  if (game.gameHistory && game.gameHistory.length > 0) {
    processGameHistory(gameId, game.gameHistory);
  }
}

/**
 * Updates the team's knowledge of word assignments
 */
function updateTeamWords(memory: TeamGameMemory, game: Game, team: "red" | "blue"): void {
  // Update team's own words
  memory.teamWords = team === "red" ? game.redTeam : game.blueTeam;
  
  // Update opponent's words
  memory.opponentWords = team === "red" ? game.blueTeam : game.redTeam;
  
  // Update word associations with team information
  memory.wordAssociations.forEach((associations, word) => {
    associations.forEach(assoc => {
      assoc.isTeamWord = memory.teamWords.includes(word);
      assoc.isOpponentWord = memory.opponentWords.includes(word);
      assoc.isNeutralWord = !assoc.isTeamWord && !assoc.isOpponentWord && word !== memory.assassinWord;
      assoc.isAssassin = word === memory.assassinWord;
    });
  });
}

/**
 * Processes game history to update strategic memory
 */
function processGameHistory(gameId: number, history: GameHistoryEntry[]): void {
  const redMemory = getTeamMemory(gameId, "red");
  const blueMemory = getTeamMemory(gameId, "blue");
  
  // First pass: extract clues and guesses
  const clues = new Map<string, {
    clue: string;
    number: number;
    team: "red" | "blue";
    timestamp: number;
    guesses: {
      word: string;
      result: "correct" | "wrong" | "assassin" | "unknown";
      timestamp: number;
    }[];
  }>();
  
  // Extract clues
  history.filter(entry => entry.type === "clue").forEach(entry => {
    const match = entry.content.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const [_, clueWord, clueNumber] = match;
      clues.set(entry.content, {
        clue: clueWord,
        number: parseInt(clueNumber),
        team: entry.turn,
        timestamp: entry.timestamp,
        guesses: []
      });
    }
  });
  
  // Associate guesses with clues
  history.filter(entry => entry.type === "guess" && entry.word).forEach(entry => {
    // Find the most recent clue for this team
    const teamClues = Array.from(clues.values())
      .filter(c => c.team === entry.turn)
      .sort((a, b) => b.timestamp - a.timestamp);
    
    if (teamClues.length > 0) {
      const latestClue = teamClues[0];
      latestClue.guesses.push({
        word: entry.word,
        result: entry.result || "unknown",
        timestamp: entry.timestamp
      });
    }
  });
  
  // Second pass: update team memories with clue results
  clues.forEach((clueData, clueKey) => {
    const teamMemory = clueData.team === "red" ? redMemory : blueMemory;
    const opposingMemory = clueData.team === "red" ? blueMemory : redMemory;
    
    // Process this clue, regardless of whether we've seen it before
    // (This ensures we track all guessing activity, even for previously processed clues)
    const correctGuesses = clueData.guesses.filter(g => g.result === "correct").map(g => g.word);
    const wrongGuesses = clueData.guesses.filter(g => g.result !== "correct" && g.result !== undefined).map(g => g.word);
    
    // Determine if clue was successful
    const success = correctGuesses.length > 0;
    const failure = wrongGuesses.length > 0;
    
    // Create or update clue memory
    let clueMemory: ClueMemory;
    
    if (teamMemory.activeClues.has(clueKey)) {
      // Update existing active clue
      clueMemory = teamMemory.activeClues.get(clueKey)!;
      clueMemory.guessedWords = [...new Set([...clueMemory.guessedWords, ...correctGuesses, ...wrongGuesses])];
      clueMemory.remainingGuesses = Math.max(0, clueData.number - correctGuesses.length);
      clueMemory.success = success;
      clueMemory.failure = failure;
    } else {
      // Create new clue memory
      clueMemory = {
        clue: clueData.clue,
        number: clueData.number,
        timestamp: clueData.timestamp,
        suggestedWords: [], // Will be populated from discussion analysis
        guessedWords: [...correctGuesses, ...wrongGuesses],
        remainingGuesses: Math.max(0, clueData.number - correctGuesses.length),
        success,
        failure
      };
    }
    
    // Update team scores based on guess results
    correctGuesses.forEach(word => {
      // Correct guess: +1 for current team
      teamMemory.gameScore[clueData.team] += 1;
    });
    
    wrongGuesses.forEach(word => {
      // If guess revealed opposing team's word: +1 for opposing team
      const opposingTeam = clueData.team === "red" ? "blue" : "red";
      if (
        (clueData.team === "red" && blueMemory.teamWords.includes(word)) ||
        (clueData.team === "blue" && redMemory.teamWords.includes(word))
      ) {
        opposingMemory.gameScore[opposingTeam] += 1;
      }
      // Neutral words: +0 (no score change)
    });
    
    // Process active clues
    if (!failure && clueMemory.remainingGuesses > 0) {
      // Clue is still active if not failed and has remaining guesses
      teamMemory.activeClues.set(clueKey, clueMemory);
    } else if (teamMemory.activeClues.has(clueKey) && (failure || clueMemory.remainingGuesses <= 0)) {
      // Remove from active clues if it's now exhausted or failed
      if (success) {
        teamMemory.successfulClues.push(clueMemory);
      } else {
        teamMemory.failedClues.push(clueMemory);
      }
      teamMemory.activeClues.delete(clueKey);
    }
    
    // Update guest statistics
    teamMemory.correctGuesses = correctGuesses.length;
    teamMemory.incorrectGuesses = wrongGuesses.length;
  });
}

/**
 * Updates memory based on team discussion
 */
export function updateDiscussionMemory(
  gameId: number,
  team: "red" | "blue",
  clue: { word: string; number: number },
  teamDiscussion: TeamDiscussionEntry[],
  gameHistory: GameHistoryEntry[],
  revealedCards: string[],
  currentRound: number
): void {
  const memory = getTeamMemory(gameId, team);
  const clueKey = `${clue.word} (${clue.number})`;
  const now = Date.now();
  
  console.log(`📝 Updating discussion memory for ${team} team, clue: "${clue.word}", round: ${currentRound}`);
  
  // Initialize or update active clue
  if (!memory.activeClues.has(clueKey)) {
    memory.activeClues.set(clueKey, {
      clue: clue.word,
      number: clue.number,
      timestamp: now,
      suggestedWords: [],
      guessedWords: [],
      remainingGuesses: clue.number,
      success: false,
      failure: false
    });
    console.log(`🆕 Adding new active clue to memory: "${clue.word}" (${clue.number})`);
  }
  
  const activeClue = memory.activeClues.get(clueKey)!;
  
  // Update guessed words for this clue from game history
  const clueGuesses = gameHistory.filter(entry => 
    entry.type === "guess" && 
    entry.relatedClue === clueKey &&
    entry.word
  );
  
  const correctGuesses = clueGuesses
    .filter(entry => entry.result === "correct")
    .map(entry => entry.word);
  
  const wrongGuesses = clueGuesses
    .filter(entry => entry.result !== "correct" && entry.result !== undefined)
    .map(entry => entry.word);
  
  activeClue.guessedWords = [...correctGuesses, ...wrongGuesses];
  activeClue.remainingGuesses = Math.max(0, clue.number - correctGuesses.length);
  activeClue.success = correctGuesses.length > 0;
  activeClue.failure = wrongGuesses.length > 0;
  
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
  const conflicts: ConflictMemory[] = [];
  
  // First pass: collect all word suggestions
  const entriesByRound = teamDiscussion
    .filter(entry => entry.round === currentRound || !entry.round)
    .sort((a, b) => a.timestamp - b.timestamp);
  
  entriesByRound.forEach(entry => {
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
      wordData.mentions++;
      wordData.lastMentioned = Math.max(wordData.lastMentioned, entry.timestamp);
      
      // Determine support or opposition based on confidence
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
  
  // Second pass: detect conflicts between suggestions
  const agentSuggestions = new Map<string, string[]>();
  entriesByRound.forEach(entry => {
    if (entry.suggestedWord) {
      if (!agentSuggestions.has(entry.player)) {
        agentSuggestions.set(entry.player, []);
      }
      if (!agentSuggestions.get(entry.player)!.includes(entry.suggestedWord)) {
        agentSuggestions.get(entry.player)!.push(entry.suggestedWord);
      }
    }
  });
  
  // Look for explicit disagreements in messages
  for (let i = 0; i < entriesByRound.length; i++) {
    const entry = entriesByRound[i];
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
        const prevEntry = entriesByRound[j];
        
        // Only consider disagreements between different agents
        if (prevEntry.player === entry.player) continue;
        
        // If the current message mentions the previous suggestion, it's likely a disagreement
        if (prevEntry.suggestedWord && msgLower.includes(prevEntry.suggestedWord.toLowerCase())) {
          // Don't add duplicate conflicts
          const existingConflict = conflicts.some(
            c => (c.wordA === prevEntry.suggestedWord && c.wordB === entry.suggestedWord) ||
                 (c.wordA === entry.suggestedWord && c.wordB === prevEntry.suggestedWord)
          );
          
          if (!existingConflict) {
            conflicts.push({
              wordA: prevEntry.suggestedWord,
              wordB: entry.suggestedWord || "",
              agentA: prevEntry.player,
              agentB: entry.player,
              resolved: false,
              timestamp: entry.timestamp
            });
            
            console.log(`🔄 Detected conflict between "${prevEntry.suggestedWord}" and "${entry.suggestedWord}" (${prevEntry.player} vs ${entry.player})`);
          }
        }
      }
    }
  }
  
  // Update active clue with suggested words
  activeClue.suggestedWords = Array.from(wordSuggestions.entries())
    .map(([word, data]) => {
      // Check if we have an existing association for this word
      const existingAssociations = memory.wordAssociations.get(word) || [];
      const existingAssoc = existingAssociations.find(a => a.clue === clue.word);
      
      const wordAssoc: WordAssociation = existingAssoc || {
        word,
        clue: clue.word,
        confidence: data.confidence / Math.max(1, data.supporters.size),
        mentionCount: data.mentions,
        firstMentionedAt: existingAssoc?.firstMentionedAt || now,
        lastMentionedAt: data.lastMentioned,
        supporters: Array.from(data.supporters),
        opposers: Array.from(data.opposers),
        risk: data.risk,
        relatedWords: [],
        status: revealedCards.includes(word) ? "guessed" : 
                data.opposers.size > data.supporters.size ? "rejected" : 
                data.supporters.size > 0 ? "active" : "uncertain",
        isTeamWord: memory.teamWords.includes(word),
        isOpponentWord: memory.opponentWords.includes(word),
        isNeutralWord: !memory.teamWords.includes(word) && !memory.opponentWords.includes(word) && word !== memory.assassinWord,
        isAssassin: word === memory.assassinWord
      };
      
      if (existingAssoc) {
        // Update existing association
        existingAssoc.confidence = Math.max(existingAssoc.confidence, wordAssoc.confidence);
        existingAssoc.mentionCount += wordAssoc.mentionCount;
        existingAssoc.lastMentionedAt = wordAssoc.lastMentionedAt;
        existingAssoc.supporters = [...new Set([...existingAssoc.supporters, ...wordAssoc.supporters])];
        existingAssoc.opposers = [...new Set([...existingAssoc.opposers, ...wordAssoc.opposers])];
        existingAssoc.status = wordAssoc.status;
        existingAssoc.risk = wordAssoc.risk === "High" || existingAssoc.risk === "High" ? 
                           "High" : (wordAssoc.risk === "Medium" || existingAssoc.risk === "Medium" ? 
                                   "Medium" : "Low");
        return existingAssoc;
      } else {
        // Add new association to memory
        if (!memory.wordAssociations.has(word)) {
          memory.wordAssociations.set(word, []);
        }
        memory.wordAssociations.get(word)!.push(wordAssoc);
        return wordAssoc;
      }
    })
    .sort((a, b) => {
      const supportRatioA = a.supporters.length - a.opposers.length;
      const supportRatioB = b.supporters.length - b.opposers.length;
      if (supportRatioB !== supportRatioA) return supportRatioB - supportRatioA;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.mentionCount - a.mentionCount;
    });
  
  // Update discussion history
  const consensusInfo = calculateConsensus(wordSuggestions, Array.from(agentSuggestions.keys()).length);
  
  memory.discussionHistory.push({
    round: currentRound,
    timestamp: now,
    wordSuggestions: Array.from(wordSuggestions.keys()),
    conflicts,
    consensus: {
      reached: consensusInfo.consensusLevel === "High",
      word: consensusInfo.consensusWord,
      supportLevel: consensusInfo.consensusLevel,
      supporters: consensusInfo.consensusWord ? 
                Array.from(wordSuggestions.get(consensusInfo.consensusWord)?.supporters || []) : [],
      opposers: consensusInfo.consensusWord ? 
                Array.from(wordSuggestions.get(consensusInfo.consensusWord)?.opposers || []) : []
    }
  });
  
  console.log(`📊 Memory updated for clue "${clue.word}". Active words: ${activeClue.suggestedWords.map(w => w.word).join(', ')}`);
  
  // Update agent personality data
  entriesByRound.forEach(entry => {
    if (!memory.agentPersonalities.has(entry.player)) {
      memory.agentPersonalities.set(entry.player, {
        riskTolerance: "balanced",
        wordAssociations: new Map(),
        agreementWith: new Map()
      });
    }
    
    const personality = memory.agentPersonalities.get(entry.player)!;
    
    // Update risk tolerance based on suggestions
    if (entry.suggestedWord && entry.risk) {
      const riskCounts = {
        High: personality.riskTolerance === "conservative" ? 1 : 0,
        Medium: personality.riskTolerance === "balanced" ? 1 : 0,
        Low: personality.riskTolerance === "aggressive" ? 1 : 0
      };
      
      riskCounts[entry.risk]++;
      
      // Update risk tolerance based on majority of suggestions
      if (riskCounts.High > riskCounts.Medium && riskCounts.High > riskCounts.Low) {
        personality.riskTolerance = "conservative";
      } else if (riskCounts.Low > riskCounts.High && riskCounts.Low > riskCounts.Medium) {
        personality.riskTolerance = "aggressive";
      } else {
        personality.riskTolerance = "balanced";
      }
    }
    
    // Update word associations
    if (entry.suggestedWord && entry.message) {
      if (!personality.wordAssociations.has(clue.word)) {
        personality.wordAssociations.set(clue.word, []);
      }
      
      const associations = personality.wordAssociations.get(clue.word)!;
      if (!associations.includes(entry.suggestedWord)) {
        associations.push(entry.suggestedWord);
      }
    }
    
    // Update agreement with other agents
    if (entry.suggestedWord) {
      entriesByRound.forEach(otherEntry => {
        if (otherEntry.player !== entry.player && otherEntry.suggestedWord) {
          if (!personality.agreementWith.has(otherEntry.player)) {
            personality.agreementWith.set(otherEntry.player, 0);
          }
          
          const agreement = personality.agreementWith.get(otherEntry.player)!;
          if (otherEntry.suggestedWord === entry.suggestedWord) {
            // They agree on this word
            personality.agreementWith.set(otherEntry.player, agreement + 1);
          } else {
            // They disagree
            personality.agreementWith.set(otherEntry.player, agreement - 0.5);
          }
        }
      });
    }
  });
  
  // Find related words based on common clues
  for (const [word, associations] of memory.wordAssociations.entries()) {
    associations.forEach(assoc => {
      // Find other words associated with the same clue
      const relatedWords = new Set<string>();
      
      for (const [otherWord, otherAssocs] of memory.wordAssociations.entries()) {
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
  
  // Process active clues, but DON'T clean up old clues unless they're fully guessed
  // This allows old unresolved clues to be remembered and used in future turns
  for (const [clueKey, clueData] of memory.activeClues.entries()) {
    // Only mark as inactive if all words have been revealed (not just if guesses are used up)
    const allSuggestedWordsRevealed = clueData.suggestedWords.length > 0 && 
                                     clueData.suggestedWords.every(w => revealedCards.includes(w.word));
    
    // We don't remove clues based on remainingGuesses anymore - this allows the +1 extra guess rule
    // and also retains historical clues with unguessed words
    
    if (allSuggestedWordsRevealed) {
      if (clueKey !== clue.word) { // Don't remove the current clue
        console.log(`🗑️ Cleaning up fully revealed clue: "${clueKey}"`);
        memory.activeClues.delete(clueKey);
      }
    } else {
      // Keep this clue active but update its stats based on revealed cards
      const guessedWords = clueData.suggestedWords
        .filter(w => revealedCards.includes(w.word))
        .map(w => w.word);
      
      clueData.guessedWords = [...new Set([...clueData.guessedWords, ...guessedWords])];
      
      // Update clue status based on what happened in game
      for (const suggestion of clueData.suggestedWords) {
        if (revealedCards.includes(suggestion.word)) {
          suggestion.status = "guessed";
          // Update knowledge about whether this was a team word
          suggestion.isTeamWord = memory.teamWords.includes(suggestion.word);
          suggestion.isOpponentWord = memory.opponentWords.includes(suggestion.word);
          suggestion.isNeutralWord = !suggestion.isTeamWord && !suggestion.isOpponentWord && suggestion.word !== memory.assassinWord;
          suggestion.isAssassin = suggestion.word === memory.assassinWord;
        }
      }
    }
  }
}

/**
 * Calculate consensus metrics from word suggestions
 */
function calculateConsensus(
  wordSuggestions: Map<string, {
    confidence: number,
    supporters: Set<string>,
    opposers: Set<string>,
    mentions: number,
    lastMentioned: number,
    risk: RiskLevel
  }>,
  totalParticipants: number
): {
  consensusWord: string | null;
  consensusLevel: ConsensusLevel;
} {
  if (wordSuggestions.size === 0) {
    return {
      consensusWord: null,
      consensusLevel: "None"
    };
  }
  
  // Calculate support metrics for each word
  const wordMetrics = Array.from(wordSuggestions.entries()).map(([word, data]) => {
    const supportRatio = data.supporters.size / Math.max(1, data.opposers.size);
    const supportPercentage = data.supporters.size / totalParticipants;
    const netSupport = data.supporters.size - data.opposers.size;
    
    return {
      word,
      supporters: data.supporters.size,
      opposers: data.opposers.size,
      supportRatio,
      supportPercentage,
      netSupport,
      risk: data.risk,
      avgConfidence: data.confidence / Math.max(1, data.supporters.size)
    };
  }).sort((a, b) => {
    if (b.netSupport !== a.netSupport) return b.netSupport - a.netSupport;
    if (b.supportRatio !== a.supportRatio) return b.supportRatio - a.supportRatio;
    return b.avgConfidence - a.avgConfidence;
  });
  
  if (wordMetrics.length === 0) {
    return {
      consensusWord: null,
      consensusLevel: "None"
    };
  }
  
  const topWord = wordMetrics[0];
  
  // Determine consensus level
  let consensusLevel: ConsensusLevel;
  
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
    consensusLevel
  };
}

/**
 * Updates memory with game turn results
 */
export function updateTurnResults(
  gameId: number,
  team: "red" | "blue",
  guessedWord: string,
  result: "correct" | "wrong" | "assassin",
  clue?: { word: string; number: number }
): void {
  const memory = getTeamMemory(gameId, team);
  const opposingTeam = team === "red" ? "blue" : "red";
  const opposingMemory = getTeamMemory(gameId, opposingTeam);
  
  // Mark word as revealed first
  if (!memory.revealedCards.includes(guessedWord)) {
    memory.revealedCards.push(guessedWord);
  }
  
  // Update scores based on the result
  if (result === "correct") {
    memory.correctGuesses++;
    
    // Update team score: +1 for guessing your own team's word correctly
    memory.gameScore[team]++;
    console.log(`✅ ${team} team score updated: +1 point for guessing "${guessedWord}" correctly`);
  } else if (result === "wrong") {
    memory.incorrectGuesses++;
    
    // If the guessed word belongs to opposing team, they get a point
    if (
      (team === "red" && opposingMemory.teamWords.includes(guessedWord)) ||
      (team === "blue" && opposingMemory.teamWords.includes(guessedWord))
    ) {
      opposingMemory.gameScore[opposingTeam]++;
      console.log(`🔄 ${opposingTeam} team score updated: +1 point because ${team} team guessed their word "${guessedWord}"`);
    }
    
    // Neutral words don't change score
    
    // Switch active team
    memory.currentTeam = opposingTeam;
  } else if (result === "assassin") {
    memory.incorrectGuesses++;
    // Assassin ends the game with opposing team winning
    // (score update handled by game state)
    memory.currentTeam = opposingTeam;
  }
  
  // Update active and historical clues to track this guess
  if (clue) {
    const clueKey = `${clue.word} (${clue.number})`;
    
    // Update active clue if we have it
    if (memory.activeClues.has(clueKey)) {
      const activeClue = memory.activeClues.get(clueKey)!;
      
      // Add to guessed words if not already there
      if (!activeClue.guessedWords.includes(guessedWord)) {
        activeClue.guessedWords.push(guessedWord);
      }
      
      // Update success/failure status
      if (result === "correct") {
        activeClue.success = true;
        // Decrement remaining guesses but don't set to 0
        // (The +1 rule is handled in getActiveClues)
        activeClue.remainingGuesses = Math.max(0, activeClue.remainingGuesses - 1);
      } else {
        // Wrong guesses end the turn
        activeClue.failure = true;
        
        // We DON'T delete the active clue immediately
        // Instead, we keep it in memory for future turns if there are still viable unrevealed words
        const allWordsSuggested = activeClue.suggestedWords
          .filter(w => !memory.revealedCards.includes(w.word))
          .length === 0;
          
        if (allWordsSuggested) {
          console.log(`Moving clue "${clueKey}" to failed clues list (all words revealed)`);
          memory.failedClues.push(activeClue);
          memory.activeClues.delete(clueKey);
        }
      }
    }
  }
  
  // Update word associations status to "guessed" for this word
  for (const [word, associations] of memory.wordAssociations.entries()) {
    if (word === guessedWord) {
      associations.forEach(assoc => {
        assoc.status = "guessed";
        // Update knowledge about word type based on results
        if (result === "correct") {
          assoc.isTeamWord = true;
          assoc.isOpponentWord = false;
          assoc.isNeutralWord = false;
          assoc.isAssassin = false;
        } else if (result === "wrong") {
          assoc.isTeamWord = false;
          // Check if it's opponent's word
          assoc.isOpponentWord = (
            (team === "red" && opposingMemory.teamWords.includes(guessedWord)) ||
            (team === "blue" && opposingMemory.teamWords.includes(guessedWord))
          );
          assoc.isNeutralWord = !assoc.isOpponentWord;
          assoc.isAssassin = false;
        } else if (result === "assassin") {
          assoc.isTeamWord = false;
          assoc.isOpponentWord = false;
          assoc.isNeutralWord = false;
          assoc.isAssassin = true;
        }
      });
    }
  }
  
  console.log(`📊 Turn result updated: ${team} guessed "${guessedWord}" - ${result}`);
}

/**
 * Retrieves currently active clues for a team, including from previous turns
 * This includes both current active clues and unresolved previous clues
 */
export function getActiveClues(gameId: number, team: "red" | "blue", currentClue?: string): {
  clue: string;
  number: number;
  remainingGuesses: number;
  suggestedWords: string[];
  originalNumber: number; // Added original clue number for reference
  guessedWords: string[]; // Added to track words already guessed for this clue
  timestamp: number;     // Added to sort by recency
}[] {
  const memory = getTeamMemory(gameId, team);
  
  // Gather historical successful and failed clues too
  const allClueMemories = new Map(memory.activeClues);
  
  // Make sure we don't include the current clue in the list if it's provided
  const filteredEntries = Array.from(allClueMemories.entries())
    .filter(([key, _]) => !currentClue || key !== currentClue);
  
  return filteredEntries
    .map(([_, data]) => {
      // For each clue, get unrevealed suggested words
      const unrevealed = data.suggestedWords
        .filter(w => (w.status === "active" || w.status === "uncertain") && 
                     !memory.revealedCards.includes(w.word))
        .sort((a, b) => b.confidence - a.confidence)
        .map(w => w.word);
      
      return {
        clue: data.clue,
        number: data.number,
        originalNumber: data.number, // Original number from when clue was given
        // For +1 rule: If the clue had X words, they can guess X+1 times total
        // So remainingGuesses = original number + 1 - words already guessed
        remainingGuesses: Math.max(0, data.number + 1 - data.guessedWords.length),
        suggestedWords: unrevealed,
        guessedWords: data.guessedWords,
        timestamp: data.timestamp
      };
    })
    // Keep clues with unrevealed suggested words, even if guesses are used up
    // This ensures old unresolved clues are considered for future turns
    .filter(clueData => clueData.suggestedWords.length > 0)
    // Sort by timestamp (most recent first)
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Retrieves discussion summary for a specific round
 */
export function getDiscussionSummary(
  gameId: number,
  team: "red" | "blue",
  round: number
): DiscussionRound | undefined {
  const memory = getTeamMemory(gameId, team);
  return memory.discussionHistory.find(r => r.round === round);
}

/**
 * Resolves a conflict between words
 */
export function resolveConflict(
  gameId: number,
  team: "red" | "blue",
  wordA: string,
  wordB: string,
  resolution: string,
  resolvedBy: string
): boolean {
  const memory = getTeamMemory(gameId, team);
  
  // Find the conflict in discussion history
  for (const round of memory.discussionHistory) {
    const conflict = round.conflicts.find(c => 
      (c.wordA === wordA && c.wordB === wordB) || 
      (c.wordA === wordB && c.wordB === wordA)
    );
    
    if (conflict) {
      conflict.resolved = true;
      conflict.resolution = resolution;
      conflict.resolvedBy = resolvedBy;
      return true;
    }
  }
  
  return false;
}

/**
 * Analyzes team member interaction patterns
 */
export function analyzeTeamInteractions(
  gameId: number,
  team: "red" | "blue"
): {
  strongPairs: [string, string][]; // Agents who agree often
  conflicts: [string, string][]; // Agents who disagree often
  influencers: string[]; // Agents whose suggestions are often followed
  conservatives: string[]; // Risk-averse agents
  risktakers: string[]; // Risk-tolerant agents
} {
  const memory = getTeamMemory(gameId, team);
  const result = {
    strongPairs: [] as [string, string][],
    conflicts: [] as [string, string][],
    influencers: [] as string[],
    conservatives: [] as string[],
    risktakers: [] as string[]
  };
  
  // Find personality-based classifications
  for (const [agent, personality] of memory.agentPersonalities.entries()) {
    if (personality.riskTolerance === "conservative") {
      result.conservatives.push(agent);
    } else if (personality.riskTolerance === "aggressive") {
      result.risktakers.push(agent);
    }
    
    // Find agents with high agreement
    for (const [otherAgent, agreement] of personality.agreementWith.entries()) {
      if (agreement >= 2) {
        const pair: [string, string] = [agent, otherAgent].sort() as [string, string];
        if (!result.strongPairs.some(p => p[0] === pair[0] && p[1] === pair[1])) {
          result.strongPairs.push(pair);
        }
      } else if (agreement <= -2) {
        const pair: [string, string] = [agent, otherAgent].sort() as [string, string];
        if (!result.conflicts.some(p => p[0] === pair[0] && p[1] === pair[1])) {
          result.conflicts.push(pair);
        }
      }
    }
  }
  
  // Identify influencers based on how often their suggestions become consensus
  const agentSuccessRate = new Map<string, { suggested: number; accepted: number }>();
  
  memory.discussionHistory.forEach(round => {
    if (round.consensus?.reached && round.consensus.word) {
      const consensusWord = round.consensus.word;
      
      // Credit all supporters
      round.consensus.supporters.forEach(agent => {
        if (!agentSuccessRate.has(agent)) {
          agentSuccessRate.set(agent, { suggested: 0, accepted: 0 });
        }
        
        const stats = agentSuccessRate.get(agent)!;
        stats.accepted++;
      });
    }
    
    // Count all suggestions
    round.wordSuggestions.forEach(word => {
      memory.wordAssociations.get(word)?.forEach(assoc => {
        assoc.supporters.forEach(agent => {
          if (!agentSuccessRate.has(agent)) {
            agentSuccessRate.set(agent, { suggested: 0, accepted: 0 });
          }
          
          const stats = agentSuccessRate.get(agent)!;
          stats.suggested++;
        });
      });
    });
  });
  
  // Find agents with high success rate
  for (const [agent, stats] of agentSuccessRate.entries()) {
    if (stats.suggested >= 3 && stats.accepted / stats.suggested > 0.7) {
      result.influencers.push(agent);
    }
  }
  
  return result;
}

/**
 * Exports strategic information for the spymaster
 */
export function getSpymasterStrategicInfo(
  gameId: number,
  team: "red" | "blue"
): {
  teamWords: { word: string; revealed: boolean }[];
  opponentWords: { word: string; revealed: boolean }[];
  neutralWords: { word: string; revealed: boolean }[];
  assassinWord: string;
  successfulClues: { clue: string; words: string[] }[];
  failedClues: { clue: string; words: string[] }[];
  teamPerformance: {
    correctGuessRate: number;
    averageGuessesPerClue: number;
  };
} {
  const memory = getTeamMemory(gameId, team);
  
  return {
    teamWords: memory.teamWords.map(word => ({
      word,
      revealed: memory.revealedCards.includes(word)
    })),
    
    opponentWords: memory.opponentWords.map(word => ({
      word,
      revealed: memory.revealedCards.includes(word)
    })),
    
    neutralWords: memory.wordAssociations.has(memory.assassinWord) 
      ? Array.from(memory.wordAssociations.keys())
          .filter(word => 
            !memory.teamWords.includes(word) && 
            !memory.opponentWords.includes(word) && 
            word !== memory.assassinWord
          )
          .map(word => ({
            word,
            revealed: memory.revealedCards.includes(word)
          }))
      : [],
    
    assassinWord: memory.assassinWord,
    
    successfulClues: memory.successfulClues.map(clue => ({
      clue: clue.clue,
      words: clue.guessedWords.filter(word => memory.teamWords.includes(word))
    })),
    
    failedClues: memory.failedClues.map(clue => ({
      clue: clue.clue,
      words: clue.guessedWords
    })),
    
    teamPerformance: {
      correctGuessRate: memory.correctGuesses / (memory.correctGuesses + memory.incorrectGuesses) || 0,
      averageGuessesPerClue: memory.correctGuesses / (memory.successfulClues.length + memory.failedClues.length) || 0
    }
  };
}