import { describe, expect, it } from 'vitest';
import {
  isCallRecordingFile,
  normalizeRecordedPhone,
  parseCallRecordingFileName,
} from '../../mobile/src/lib/call-recording-filename';

const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s);

describe('parseCallRecordingFileName', () => {
  it.each([
    [
      'Google Phone',
      'Call recording +91 98765 43210_261018_143205.m4a',
      '+919876543210',
      local(2026, 10, 18, 14, 32, 5),
    ],
    [
      'Samsung',
      'Call recording 9876543210_261018_143205.m4a',
      '+919876543210',
      local(2026, 10, 18, 14, 32, 5),
    ],
    [
      'Xiaomi',
      'Ravi Kumar(9876543210)_20261018143205.mp3',
      '+919876543210',
      local(2026, 10, 18, 14, 32, 5),
    ],
    [
      'OnePlus',
      '+919876543210_20261018143205.m4a',
      '+919876543210',
      local(2026, 10, 18, 14, 32, 5),
    ],
    [
      'dashed date',
      'incoming_09876543210_2026-10-18_14-32-05.m4a',
      '+919876543210',
      local(2026, 10, 18, 14, 32, 5),
    ],
    [
      'international',
      'Call recording +44 20 7946 0958_261018_090000.m4a',
      '+442079460958',
      local(2026, 10, 18, 9, 0, 0),
    ],
  ])('reads %s names', (_recorder, fileName, phone, startedAt) => {
    const parsed = parseCallRecordingFileName(fileName);
    expect(parsed.phone).toBe(phone);
    expect(parsed.startedAt?.getTime()).toBe(startedAt.getTime());
  });

  it('keeps the contact name and asks for a number when the file has none', () => {
    const parsed = parseCallRecordingFileName('Call recording Ravi Kumar_261018_143205.m4a');
    expect(parsed).toMatchObject({ phone: null, contactName: 'Ravi Kumar' });
    expect(parsed.startedAt?.getTime()).toBe(local(2026, 10, 18, 14, 32, 5).getTime());
    expect(
      parseCallRecordingFileName('Ravi Kumar(9876543210)_20261018143205.mp3').contactName,
    ).toBe('Ravi Kumar');
  });

  it('reads the direction when the recorder writes one', () => {
    expect(parseCallRecordingFileName('incoming_9876543210_20261018143205.m4a').direction).toBe(
      'INBOUND',
    );
    expect(parseCallRecordingFileName('Outgoing 9876543210 20261018143205.m4a').direction).toBe(
      'OUTBOUND',
    );
    expect(parseCallRecordingFileName('9876543210_20261018143205.m4a').direction).toBeNull();
  });

  it('does not mistake a date for a phone number, or invent an impossible date', () => {
    expect(parseCallRecordingFileName('Recording_20261018143205.m4a')).toMatchObject({
      phone: null,
    });
    expect(parseCallRecordingFileName('9876543210_20261340999999.m4a').startedAt).toBeNull();
  });
});

describe('normalizeRecordedPhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['+1 415 555 0100', '+14155550100'],
    ['12345', null],
    ['5876543210', null],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeRecordedPhone(input)).toBe(expected);
  });
});

describe('isCallRecordingFile', () => {
  it('accepts recorder audio formats only', () => {
    expect(isCallRecordingFile('a.m4a')).toBe(true);
    expect(isCallRecordingFile('a.AMR')).toBe(true);
    expect(isCallRecordingFile('a.jpg')).toBe(false);
    expect(isCallRecordingFile('notes')).toBe(false);
  });
});
