import { describe, it, expect } from 'vitest';
import { shortAddress, suburbOf, SA_BOUNDS, isInSouthAfrica } from './geocode';

describe('shortAddress', () => {
  it('composes street, suburb and city from structured addressdetails', () => {
    const r = {
      display_name:
        'Berea Rovers Oval, 12, Marriott Road, Berea, eThekwini, KwaZulu-Natal, 4001, South Africa',
      address: { house_number: '12', road: 'Marriott Road', suburb: 'Berea', city: 'eThekwini' },
    };
    expect(shortAddress(r)).toBe('12 Marriott Road, Berea, eThekwini');
  });

  it('falls back through suburb-equivalent fields and town/municipality', () => {
    const r = { address: { road: 'Cuckoo Lane', neighbourhood: 'Congella', town: 'Durban' } };
    expect(shortAddress(r)).toBe('Cuckoo Lane, Congella, Durban');
  });

  it('omits missing parts without leaving empty segments', () => {
    const r = { address: { road: 'Sydney Road', city: 'Durban' } };
    expect(shortAddress(r)).toBe('Sydney Road, Durban');
  });

  it('drops a bare house number when no road is present', () => {
    const r = { address: { house_number: '12', suburb: 'Berea', city: 'Durban' } };
    expect(shortAddress(r)).toBe('Berea, Durban');
  });

  it('uses the first three display_name segments when no structured parts exist', () => {
    const r = { display_name: 'Somewhere, Suburbia, Big City, Province, Country' };
    expect(shortAddress(r)).toBe('Somewhere, Suburbia, Big City');
  });

  it('returns empty string when nothing usable resolves', () => {
    expect(shortAddress({})).toBe('');
    expect(shortAddress(null)).toBe('');
    expect(shortAddress({ address: {} })).toBe('');
  });
});

describe('suburbOf', () => {
  it('prefers suburb, then neighbourhood/city_district/village', () => {
    expect(suburbOf({ address: { suburb: 'Berea', neighbourhood: 'X' } })).toBe('Berea');
    expect(suburbOf({ address: { neighbourhood: 'Congella' } })).toBe('Congella');
    expect(suburbOf({ address: { village: 'Botha’s Hill' } })).toBe('Botha’s Hill');
  });

  it('returns undefined when no locality field is present', () => {
    expect(suburbOf({ address: { city: 'Durban' } })).toBeUndefined();
    expect(suburbOf({})).toBeUndefined();
    expect(suburbOf(null)).toBeUndefined();
  });
});

describe('isInSouthAfrica', () => {
  it('accepts well-known SA points', () => {
    expect(isInSouthAfrica(-29.8587, 31.0218)).toBe(true); // Durban
    expect(isInSouthAfrica(-33.9249, 18.4241)).toBe(true); // Cape Town
    expect(isInSouthAfrica(-22.35, 30.04)).toBe(true); // Musina (far north)
  });

  it('rejects points outside the SA bounding box', () => {
    expect(isInSouthAfrica(51.5074, -0.1278)).toBe(false); // London
    expect(isInSouthAfrica(-1.2921, 36.8219)).toBe(false); // Nairobi
    expect(isInSouthAfrica(-22.0, 30.0)).toBe(false); // just north of the border
  });

  it('treats the box edges as inside', () => {
    expect(isInSouthAfrica(SA_BOUNDS.south, SA_BOUNDS.west)).toBe(true);
    expect(isInSouthAfrica(SA_BOUNDS.north, SA_BOUNDS.east)).toBe(true);
  });

  it('rejects non-finite coordinates', () => {
    expect(isInSouthAfrica(NaN, 31)).toBe(false);
    expect(isInSouthAfrica(undefined, undefined)).toBe(false);
    expect(isInSouthAfrica(-29.85, Infinity)).toBe(false);
  });
});
