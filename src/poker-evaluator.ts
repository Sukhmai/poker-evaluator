import * as fs from 'fs';
import * as path from 'path';

import {DECK, DECK_KEYS, DECK_VALUES, HAND_TYPES} from './constants';
import { EvaluatedHand } from './types';
import ThreeCardConverter from './three-card-converter';
import {TableOdds, Split, PlayerOdds} from "./types/odds.interface";

// This is outside the class so evalHand is static, to keep same api as @chenosaurus/poker-evaluator
const RANKS_DATA = fs.readFileSync(path.join(__dirname, '../data/HandRanks.dat'));

export function evalHand(cards: string[] | number[]): EvaluatedHand {
  if (!RANKS_DATA) {
    throw new Error('HandRanks.dat not loaded.');
  }

  if (cards.length !== 7
    && cards.length !== 6
    && cards.length !== 5
    && cards.length !== 3) {
    throw new Error(`Hand must be 3, 5, 6, or 7 cards, but ${cards.length} cards were provided`);
  }
  if (cardsAreValidNumbers(cards)) {
    if (cards.length === 3) {
      throw new Error(`Please supply 3 card hands as string[] of "cards" only.`);
    }
    return evaluate(cards as number[]);
  }
  else if (cardsAreValidStrings(cards)) {
    let stringCards = cards as string[];
    if (stringCards.length === 3) { // If a 3 card hand, fill in to make 5 card
      stringCards = ThreeCardConverter.fillHand(stringCards);
    }
    return evaluate(convertCardsToNumbers(stringCards));
  } else {
    throw new Error(`
      Please supply input as a valid string[] | number[] of "cards".
      See src/constants/deck.const.ts for the deck's values
    `);
  }
}

export function evalCard(card: number): number {
  return RANKS_DATA.readUInt32LE(card * 4);
}

function convertCardsToNumbers(cards: string[]): number[] {
  return cards.map(card => DECK[card.toLowerCase()]);
}

function cardsAreValidStrings(cards: string[] | number[]): boolean {
  return cards.every((card: string | number) =>
    typeof card === 'string' && DECK_KEYS.has(card.toLowerCase()));
}

function cardsAreValidNumbers(cards: string[] | number[]): boolean {
  return cards.every((card: string | number) =>
    typeof card === 'number' && DECK_VALUES.has(card));
}

function evaluate(cardValues: number[]): EvaluatedHand {
  let p = 53;
  cardValues.forEach(cardValue => p = evalCard(p + cardValue));

  if (cardValues.length === 5 || cardValues.length === 6) {
    p = evalCard(p);
  }

  return {
    handType: p >> 12,
    handRank: p & 0x00000fff,
    value: p,
    handName: HAND_TYPES[p >> 12]
  }
}

/**
 * This function takes the cards in a players hand as well as the community cards (if any) on the table.
 * Given the player count at the table and the number of simulation cycles to run, this estimates the odds of winning the hand.
 * Split pots are not counted as a win, so with a royal flush community hand, every player would have winning odds of 0.0.
 * The more cycles used, the more precise the number will become.  The time complexity of this function is a factor
 * of the player count multiplied by the number of cycles.  Hands with fewer cards on the table will take slightly longer.
 *
 * This does not use any tables, mathematical functions, or other heuristics.  It simply uses a Monte Carlo method.
 * This means that winning odds will vary with the same cards between runs, even with a very high cycle count.
 *
 * Cycles counts of 1000 tend to yield similar results to 100000 however, so unlike a chess engine, there are not
 * dramatically different qualities of results with longer calculating times.  In cases where the player may be aiming
 * for something very unlikely, like a straight flush or four of a kind, running 30000 or more cycles will help in getting
 * odds other than 0, instead yielding the correct ~0.0001.
 */
export function winningOddsForPlayer (hand: string[], community: string[], playerCount: number, cycles: number): PlayerOdds {
  // Above 23 players, we run out of cards in a deck.  23 * 2 + 5 = 51
  if (playerCount > 23) {
    throw new Error("You may have at most 23 players.")
  }

  // Hand with no knowledge of other players hands
  return winningOddsForTable([hand, ...Array(playerCount - 1).fill([])], community, playerCount, cycles)['players'][0];
}

export function winningOddsForTable(knownPartialHands: string[][], community: string[], playerCount:number, cycles:number): TableOdds {
  const numCommunity = convertCardsToNumbers(community);
  const numHands = knownPartialHands.map(convertCardsToNumbers);
  const allHoleCards = numHands.reduce((group, currentHand) => [...group, ...currentHand], []);
  const startingDeck = deckWithoutSpecifiedCards([...numCommunity, ...allHoleCards]);
  const startingSplits = [];
  for (let i = 0; i < playerCount; i++) {
    startingSplits.push(Array(playerCount - 1).fill(0));
  }
  const data = {
    'wins': Array(playerCount).fill(0),
    'splits': startingSplits
  };

  for (let i = 0; i < cycles; i++) {
    shuffleDeck(startingDeck);
    let deckPosition = 0;
    const interimCommunity = [...numCommunity];

    // Fill in players cards from the deck if not provided
    const holeCards = [];
    for (let p = 0; p < playerCount; p++) {
      const card1= numHands[p].length >= 1 ? numHands[p][0] : startingDeck[deckPosition++];
      const card2 = numHands[p].length == 2 ? numHands[p][1] : startingDeck[deckPosition++];
      holeCards.push([card1, card2]);
    }

    while (interimCommunity.length < 5) {
      interimCommunity.push(startingDeck[deckPosition++]);
    }

    // Calculate the ranks of each hand
    const handValues = holeCards.map(hand => evalHand([...hand, ...interimCommunity]).value);

    // Find the winning hands this round
    let winningIndexes = [];
    let bestRank = -1;
    for (let p = 0; p < playerCount; p++) {
      if (handValues[p] > bestRank) {
        winningIndexes = [p];
        bestRank = handValues[p];
      } else if (handValues[p] === bestRank) {
        winningIndexes.push(p);
      }
    }

    if (winningIndexes.length > 1) {
      for (let i = 0; i < winningIndexes.length; i++) {
        // Increment that players split count of this size
        data['splits'][winningIndexes[i]][winningIndexes.length - 2] += 1;
      }
    } else {
      data['wins'][winningIndexes[0]] += 1;
    }
  }
  return buildPlayerData(data, cycles);
}

function buildPlayerData(rawData: object, cycles: number): TableOdds {
  const playerCount = rawData['wins'].length;
  const players = [];
  for (let p = 0; p < playerCount; p++) {

    const winRate = rawData['wins'][p] / cycles;
    const splitList = [];
    for (let i = 0; i < rawData['splits'][0].length; i++) {
      splitList.push({'rate': rawData['splits'][p][i] / cycles, 'ways': i + 2});
    }
    players.push({'winRate': winRate, 'splitRates': splitList});
  }

  return {'players': players};
}

/**
 * Given a list of cards already dealt out, return the remaining cards that would be in the deck.
 */
function deckWithoutSpecifiedCards (cards: number[]): number[] {
  const providedSet = new Set(cards);
  return Object.values(DECK).filter(name => !providedSet.has(name));
}

/**
 * TS implementation of https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle#The_modern_algorithm
 * Code based on: https://stackoverflow.com/a/12646864
 */
function shuffleDeck (deck: number[]) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

//console.log(winningOddsForPlayer(['ah','as'],[],5, 1000))
