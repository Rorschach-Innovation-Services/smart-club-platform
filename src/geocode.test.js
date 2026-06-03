import { describe, it, expect } from 'vitest';
import { shortAddress, suburbOf } from './geocode.js';

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
