'use strict';

/**
 * The discovery filter against the kinds of listings that actually share a
 * Pokemon search page: the real drop, marketplace imports, and merch.
 */

const test = require('node:test');
const assert = require('node:assert');

const { screen, matchTerms, slugText } = require('../src/discovery/filter');
const { DEFAULT_RULES } = require('../app/state');

const ok = (title) => screen(title, DEFAULT_RULES).ok;

test('new English sealed product passes the default rules', () => {
  for (const title of [
    'Pokémon Trading Card Game: Scarlet & Violet Elite Trainer Box',
    'Pokemon TCG: Mega Evolution Booster Bundle',
    'Pokemon TCG Prismatic Evolutions Super-Premium Collection',
    'Pokemon TCG Mini Tins (Assorted)',
    'Pokémon TCG: Build & Battle Box',
    'Pokemon Scarlet & Violet Paldea Figure Collection',
  ]) {
    assert.ok(ok(title), `should pass: ${title}`);
  }
});

test('imports, merch and resale junk are rejected', () => {
  for (const title of [
    'Pokemon Japanese Terastal Festival Booster Box',
    'Pokemon Card Game Battle Partners Booster Box JP',
    'Korean Pokemon TCG Booster Pack',
    'Pokemon Simplified Chinese Gem Pack Vol 3',
    'Pokemon Pikachu Plush 8"',
    'Ultra Pro Pokemon Card Sleeves 65ct',
    'Pokemon Mens Graphic T-Shirt',
    'Lot of 100 Pokemon TCG Cards',
    'Pokemon TCG Mystery Box Repack',
    'Empty Pokemon Elite Trainer Box (no cards)',
    'Pokemon Legends Z-A - Nintendo Switch',
  ]) {
    assert.ok(!ok(title), `should reject: ${title}`);
  }
});

test('other card games are rejected even though they say TCG', () => {
  assert.ok(!ok('One Piece Card Game TCG Booster Box'));
  assert.ok(!ok('Disney Lorcana Trading Card Game Booster Pack'));
});

test('matching is whole-word, accent-folded and plural-tolerant', () => {
  assert.deepEqual(matchTerms('Pokémon ETBs', ['pokemon', 'etb']), ['pokemon', 'etb']);
  assert.deepEqual(matchTerms('stinger', ['tin']), []);
  assert.deepEqual(matchTerms('Mens T Shirt', ['t-shirt']), ['t-shirt']);
  assert.deepEqual(matchTerms('anything', ['', '  ']), []);
});

test('exclusion beats a keyword match', () => {
  const verdict = screen('Pokemon Japanese Elite Trainer Box', DEFAULT_RULES);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.excluded, ['japanese']);
});

test('the URL slug supplies the name when the tile text is thin', () => {
  const url = 'https://www.target.com/p/pokemon-trading-card-game-elite-trainer-box/-/A-93954435';
  assert.ok(screen(`View item ${slugText(url)}`, DEFAULT_RULES).ok);
});
