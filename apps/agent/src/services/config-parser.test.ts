import { describe, it, expect } from 'vitest';
import { detectFormat, extractConstraints, detectFieldType, isPlainObject } from './config-parser.js';

describe('Config Parser', () => {
  describe('detectFormat', () => {
    it('should detect TOML format', () => {
      expect(detectFormat('/path/to/config.toml')).toBe('toml');
    });

    it('should detect JSON format', () => {
      expect(detectFormat('/path/to/config.json')).toBe('json');
    });

    it('should detect JSON5 format', () => {
      expect(detectFormat('/path/to/config.json5')).toBe('json5');
    });

    it('should detect YAML format', () => {
      expect(detectFormat('/path/to/config.yml')).toBe('yaml');
      expect(detectFormat('/path/to/config.yaml')).toBe('yaml');
    });

    it('should detect Properties format', () => {
      expect(detectFormat('/path/to/config.properties')).toBe('properties');
      expect(detectFormat('/path/to/config.cfg')).toBe('properties');
    });

    it('should default to TOML for unknown extensions', () => {
      expect(detectFormat('/path/to/config.unknown')).toBe('toml');
    });
  });

  describe('detectFieldType', () => {
    it('should detect boolean type', () => {
      expect(detectFieldType(true)).toBe('boolean');
      expect(detectFieldType(false)).toBe('boolean');
    });

    it('should detect number type', () => {
      expect(detectFieldType(42)).toBe('number');
      expect(detectFieldType(3.14)).toBe('number');
    });

    it('should detect string type', () => {
      expect(detectFieldType('hello')).toBe('string');
    });

    it('should detect array type', () => {
      expect(detectFieldType([1, 2, 3])).toBe('array');
      expect(detectFieldType([])).toBe('array');
    });

    it('should detect object type', () => {
      expect(detectFieldType({ key: 'value' })).toBe('object');
    });
  });

  describe('isPlainObject', () => {
    it('should return true for plain objects', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ key: 'value' })).toBe(true);
    });

    it('should return false for arrays', () => {
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject([1, 2, 3])).toBe(false);
    });

    it('should return false for null', () => {
      expect(isPlainObject(null)).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(isPlainObject('string')).toBe(false);
      expect(isPlainObject(123)).toBe(false);
      expect(isPlainObject(true)).toBe(false);
    });
  });

  describe('extractConstraints', () => {
    it('should extract range constraints', () => {
      const comment = 'Range: 1 ~ 100';
      const constraints = extractConstraints(comment);
      expect(constraints).toEqual({
        min: 1,
        max: 100,
      });
    });

    it('should extract decimal range constraints', () => {
      const comment = 'Range: 0.5 ~ 5.0';
      const constraints = extractConstraints(comment);
      expect(constraints).toEqual({
        min: 0.5,
        max: 5.0,
      });
    });

    it('should extract options constraints', () => {
      const comment = 'Options: [easy, normal, hard]';
      const constraints = extractConstraints(comment);
      expect(constraints).toEqual({
        options: ['easy', 'normal', 'hard'],
      });
    });

    it('should return undefined for comments without constraints', () => {
      const comment = 'This is just a description';
      const constraints = extractConstraints(comment);
      expect(constraints).toBeUndefined();
    });

    it('should return undefined for undefined comment', () => {
      const constraints = extractConstraints(undefined);
      expect(constraints).toBeUndefined();
    });
  });
});
