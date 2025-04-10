/*************************************************************************************************

Welcome to Baml! To use this generated code, please run one of the following:

$ npm install @boundaryml/baml
$ yarn add @boundaryml/baml
$ pnpm add @boundaryml/baml

*************************************************************************************************/

// This file was generated by BAML: do not edit it. Instead, edit the BAML
// files and re-generate this code.
//
/* eslint-disable */
// tslint:disable
// @ts-nocheck
// biome-ignore format: autogenerated code
import type { Image, Audio } from "@boundaryml/baml"
import type { Checked, Check } from "./types"
import type {  ConsensusLevel,  Decision,  GameAnalysis,  GameState,  Guess,  GuessDiscussion,  MetaDecision,  Resume,  Risk,  SpymasterClue } from "./types"
import type * as types from "./types"

/******************************************************************************
*
*  These types are used for streaming, for when an instance of a type
*  is still being built up and any of its fields is not yet fully available.
*
******************************************************************************/

export interface StreamState<T> {
    value: T
    state: "Pending" | "Incomplete" | "Complete"
}

export namespace partial_types {
    
    export interface GameAnalysis {
        message?: (string | null)
        suggestedMoves?: (partial_types.Guess | null)[]
    }
    
    export interface GameState {
        currentTeam?: ("red" | "blue" | null)
        words?: (string | null)[]
        teamWords?: (string | null)[]
        opposingWords?: (string | null)[]
        assassinWord?: (string | null)
        revealedCards?: (string | null)[]
    }
    
    export interface Guess {
        word?: (string | null)
        reasoning?: (string | null)
        discussion?: (string | null)
        risk?: (Risk | null)
    }
    
    export interface GuessDiscussion {
        candidateGuesses?: (partial_types.Guess | null)[]
        discussionLog?: (string | null)[]
        conversationRounds?: (number | null)
        participantContributions?: (Record<string, (number | null)> | null)
        consensusReached?: (boolean | null)
        consensusLevel?: (ConsensusLevel | null)
        suggestedAction?: (Decision | null)
    }
    
    export interface MetaDecision {
        decision?: (Decision | null)
        reasoning?: (string | null)[]
    }
    
    export interface Resume {
        name?: (string | null)
        email?: (string | null)
        experience?: (string | null)[]
        skills?: (string | null)[]
    }
    
    export interface SpymasterClue {
        word?: (string | null)
        number?: (number | null)
        reasoning?: (string | null)
    }
    
}