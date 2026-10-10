function parseTime(text) {
  if (typeof text !== 'string') {
    throw new RangeError('Time must be a string');
  }

  const value = text.trim();
  const pattern = /^(?:(\d+):(\d{1,2}):(\d{1,2})|(\d+):(\d{1,2})|(\d+))(?:\.(\d{1,3}))?$/;
  const match = pattern.exec(value);
  if (!match) {
    throw new RangeError('Invalid time');
  }

  let seconds;
  let minutes = 0;
  let hours = 0;
  if (match[1] !== undefined) {
    hours = Number(match[1]);
    minutes = Number(match[2]);
    seconds = Number(match[3]);
  } else if (match[4] !== undefined) {
    minutes = Number(match[4]);
    seconds = Number(match[5]);
  } else {
    seconds = Number(match[6]);
  }

  if (minutes > 59 || (match[1] !== undefined || match[4] !== undefined) && seconds > 59) {
    throw new RangeError('Invalid time');
  }

  const fraction = match[7] === undefined ? 0 : Number(`0.${match[7]}`);
  const result = hours * 3600 + minutes * 60 + seconds + fraction;
  if (!Number.isFinite(result)) {
    throw new RangeError('Invalid time');
  }
  return result;
}

function formatTime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) {
    throw new RangeError('Invalid time');
  }

  let milliseconds = Math.round(sec * 1000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError('Invalid time');
  }

  const hours = Math.floor(milliseconds / 3600000);
  milliseconds %= 3600000;
  const minutes = Math.floor(milliseconds / 60000);
  milliseconds %= 60000;
  const seconds = Math.floor(milliseconds / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export { parseTime, formatTime };
