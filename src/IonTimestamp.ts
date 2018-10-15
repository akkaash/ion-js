/*
 * Copyright 2012-2016 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at:
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific
 * language governing permissions and limitations under the License.
 */

// Ion Value Support class.  This class offers the
//       additional semantics necessary for
//       timestamp values.
//
//    ION._timestamp supports:
//        new ION._timestamp(precision, offset, year, month, day, hour, minute, seconds)
//        new ION._timestamp() - returns a new null timestamp
//        new ION._timestamp(string) - parses the string to construct the timestamp
//        getEpochMilliseconds() 
//        isNull()
//        toString()
//        ION._timestamp.parse(string)
//        ION._timestamp.NULL - constant null value (non-null reference)
//        
//    The parse function returns a newly minted timestamp. If the string is
//    undefined, empty or a null image it returns the timestamp NULL.

import {Precision} from "./IonPrecision";
import {isDigit} from "./IonText";
import { BigNumber } from "bignumber.js";

const MIN_SECONDS: number = 0;
const MAX_SECONDS: number = 60;
const MIN_MINUTE: number = 0;
const MAX_MINUTE: number = 59;
const MIN_HOUR: number = 0;
const MAX_HOUR: number = 23;
const MIN_DAY: number = 1;
const MAX_DAY: number = 31;
const MIN_MONTH: number = 1;
const MAX_MONTH: number = 12;
const MIN_YEAR: number = 1;
const MAX_YEAR: number = 9999;
const MIN_OFFSET: number = (-23 * 60) - 59;
const MAX_OFFSET: number = (23 * 60) + 59;
const DAYS_PER_MONTH: number[] = [
  -1,          // months start at 1, so we fill the 0 slot
  31, 29, 31,  // jan, feb, mar
  30, 31, 30,  // apr, may, june
  31, 31, 30,  // jul, aug, sep
  31, 30, 31,  // oct, nov, dec
]

enum States {
  YEAR = 0,
  MONTH = 1,
  DAY = 2,
  HOUR = 3,
  MINUTE = 4,
  SECONDS = 5,
  OFFSET = 6,
  OFFSET_POSITIVE = 7,
  OFFSET_NEGATIVE = 8,
  OFFSET_MINUTES = 9,
  OFFSET_ZULU = 10
}

interface TransitionMap {
  [index: string]: States;
}

class TimeParserState {
  constructor(
    private _f: States,
    private _p: Precision,
    private _len: number,
    private _t: TransitionMap
  ) {}

  get f() : States {
    return this._f;
  }

  get p() : Precision {
    return this._p;
  }

  get len() : number {
    return this._len;
  }

  get t() : TransitionMap {
    return this._t;
  }
}

interface StateMap {
  [index: number]: TimeParserState;
}

const timeParserStates: StateMap = {};
timeParserStates[States.YEAR] = new TimeParserState(States.YEAR, Precision.YEAR, 4, {
  "T": States.OFFSET,
  "-": States.MONTH});
timeParserStates[States.MONTH] = new TimeParserState(States.MONTH, Precision.MONTH, 2, {
  "T": States.OFFSET,
  "-": States.DAY});
timeParserStates[States.DAY] = new TimeParserState(States.DAY, Precision.DAY, 2, {
  "T": States.HOUR});
timeParserStates[States.HOUR] = new TimeParserState(States.HOUR, undefined, 2, {
  ":": States.MINUTE});
timeParserStates[States.MINUTE] = new TimeParserState(States.MINUTE, Precision.HOUR_AND_MINUTE, 2, {
  ":": States.SECONDS,
  "+": States.OFFSET_POSITIVE,
  "-": States.OFFSET_NEGATIVE,
  "Z": States.OFFSET_ZULU});
timeParserStates[States.SECONDS] = new TimeParserState(States.SECONDS, Precision.SECONDS, 2, {
  "+": States.OFFSET_POSITIVE,
  "-": States.OFFSET_NEGATIVE,
  "Z": States.OFFSET_ZULU});
timeParserStates[States.OFFSET] = new TimeParserState(States.OFFSET, undefined, 0, {
  "+": States.OFFSET_POSITIVE,
  "-": States.OFFSET_NEGATIVE,
  "Z": States.OFFSET_ZULU});
timeParserStates[States.OFFSET_POSITIVE] = new TimeParserState(States.OFFSET_POSITIVE, undefined, 2, {
  ":": States.OFFSET_MINUTES});
timeParserStates[States.OFFSET_NEGATIVE] = new TimeParserState(States.OFFSET_NEGATIVE, undefined, 2, {
  ":": States.OFFSET_MINUTES});
timeParserStates[States.OFFSET_MINUTES] = new TimeParserState(States.OFFSET_MINUTES, undefined, 2, undefined);
timeParserStates[States.OFFSET_ZULU] = new TimeParserState(States.OFFSET_ZULU, undefined, 0, undefined);

function _to_2_digits(v: number) : string {
  let s: string = v.toString();
  switch (s.length) {
    case 0:
      return "??";
    case 1:
      return "0"+s;
    case 2:
      return s;
    default:
      return s.substr(s.length - 2, 2);
  }
}

function to_4_digits(v: number) : string {
  let s: string = v.toString();
  switch (s.length) {
    case 0:
      return "??";
    case 1:
      return "000"+s;
    case 2:
      return "00"+s;
    case 3:
      return "0"+s;
    case 4:
      return s;
    default:
      return s.substr(s.length - 4, 4);
  }
}

function read_unknown_digits(str: string, pos: number) : string {//TODO this seems incorrect
    let i: number = pos;
    let charCode;
    for (; i < str.length; i++) {
        charCode = str.charCodeAt(i)
        if (!isDigit(charCode) || (i - pos === 2 && charCode !== 46)) {
            break;
        }
    }
    return str.substring(pos, i);
}

function read_digits(str: string, pos: number, len: number) : number {
  let v: number = 0;
  for (let i: number = pos; i < pos + len; i++) {
    let c: number = str.charCodeAt(i) - 48;
    if (c < 0 && c > 9) {
      return -1;
    }
    v = (v * 10) + c;
  }
  return v;
}

const SECS_PER_MIN    = 60;
const SECS_PER_HOUR   = 60 * 60;
const SECS_PER_DAY    = 24 * 60 * 60;
const DAYS_TO_MONTH   = (function() {
  let d: number = 0;
  let a: number[] = [];
  for (let m: number = 1; m < 13; m++) {
    a.shift();
    d += DAYS_PER_MONTH[m];
  }
  return a;
})();

function is_leapyear(year: number) : boolean {
  if ((year % 4) > 0) return false; // not divisible by 4, it's not
  if ((year % 100) > 0) return true; // not divisible by 100, (but div by 4), it IS
  return (year % 1000) === 0; // 100's also divisible by 1000 ARE otherwise they're not
}

function days_to_start_of_month(month: number, year: number) : number {
  var d = DAYS_TO_MONTH[month];
  if (month > 2 && !is_leapyear(year)) d -= 1; // subtract out feb 29th
  return d;
}

function days_to_start_of_year(year: number) : number {
  let d: number = year * 365;
  d += Math.floor(year/4);    // all divisible by 4's are leap years
  d -= Math.floor(year/100);  // all 100's are not - take them out
  d += Math.floor(year/1000); // all 1000' are leap years - put them back in
  return d;
}

const SECONDS_AT_EPOCH_START: number = (function() {
  // unix epoch 1970-01-01T00:00z
  var d = days_to_start_of_year(1970) * SECS_PER_DAY;
  return d;
})();

export class Timestamp {
    readonly precision : Precision;
    readonly offset : number;
    readonly year : number;
    readonly month : number;
    readonly day : number;
    readonly hour : number;
    readonly minute : number;
    readonly seconds : BigNumber;
    readonly date : Date;
    /*
    readonly utcYear : number;
    readonly utcMonth : number;
    readonly utcDay : number;
    readonly utcHour : number;
    readonly utcMinute : number;
    */


    constructor(precision, offset, year, month, day, hour, minute, seconds) {
        if(precision === Precision.SECONDS){
            if(seconds === undefined || seconds === null) throw new Error("Seconds and precision in illegal state.");
            if (typeof seconds === 'number' || typeof seconds === 'string') {
                this.seconds = new BigNumber(seconds);
            } else if(seconds instanceof BigNumber){
                this.seconds = seconds;
            } else {
                throw new Error("Seconds must be of type number, string, or BigNumber");
            }
        }
        this.precision = precision;
        this.offset = offset;
        this.year = year;
        this.month = month;
        this.day = day;
        this.hour = hour;
        this.minute = minute;
        this.checkValid();
        this.date = new Date(Date.UTC(this.year, (this.precision === Precision.YEAR ? 0 : this.month - 1), this.day, this.hour, this.minute, null, null) - (this.offset * 60000));
        /*
        let shiftHours = Math.floor(this.offset / 60);
        let shiftMinute = this.offset - (shiftHours * 60);
        this.utcMinute = this.minute - shiftMinute;
        if(this.utcMinute < MIN_MINUTE) {
            this.utcMinute = MAX_MINUTE - (this.utcMinute + MIN_MINUTE);
            shiftHours--;
        } else if(this.utcMinute > MAX_MINUTE) {
            this.utcMinute = MIN_MINUTE + (this.utcMinute - MAX_MINUTE);
            shiftHours++;
        }
        this.utcHour = this.hour - shiftHours;
        let shiftDays = 0;
        if(this.utcHour < MIN_HOUR) {
            this.utcHour = MAX_HOUR - (this.utcHour + MIN_HOUR);
            shiftDays--;
        } else if(this.utcHour > MAX_HOUR) {
            this.utcHour = MIN_HOUR + (this.utcHour - MAX_HOUR);
            shiftDays++;
        }
        this.utcDay = this.day - shiftDays;
        if(this.utcDay < MIN_DAY) {
            this.utcMonth = this.month - 1;
            if(this.utcMonth < MIN_MONTH) {
                this.utcMonth = MAX_MONTH;
                this.utcDay = DAYS_PER_MONTH[MAX_MONTH];
            }
            this.utcDay = DAYS_PER_MONTH[this.utcMonth];
        } else if(this.utcDay > DAYS_PER_MONTH[this.month]) {
            this.utcMonth = this.month - 1;
            this.utcHour = MIN_HOUR + (this.utcHour - MAX_HOUR);
        } else {

        }
        */
    }

  private checkValid() : void {
    if (this.precision === Precision.NULL) {
      return;
    }

    if (this.offset < MIN_OFFSET || this.offset > MAX_OFFSET) {
      throw new Error(`Offset ${this.offset} must be between ${MIN_OFFSET} and ${MAX_OFFSET} inclusive`);
    }

    switch (this.precision) {
      default:
        throw new Error(`Unknown precision ${this.precision}`);
      case Precision.SECONDS:
        let seconds: number = this.seconds.toNumber();
        if (seconds < MIN_SECONDS || seconds >= MAX_SECONDS) {
          throw new Error(`Seconds ${seconds} must be between ${MIN_SECONDS} inclusive and ${MAX_SECONDS} exclusive`);
        }
      case Precision.HOUR_AND_MINUTE:
        if (this.minute < MIN_MINUTE || this.minute > MAX_MINUTE) {
          throw new Error(`Minute ${this.minute} must be between ${MIN_MINUTE} and ${MAX_MINUTE} inclusive`);
        }
        if (this.hour < MIN_HOUR || this.hour > MAX_HOUR) {
          throw new Error(`Hour ${this.hour} must be between ${MIN_HOUR} and ${MAX_HOUR} inclusive`);
        }
      case Precision.DAY:
        if (this.day < MIN_DAY || this.day > MAX_DAY) {
          throw new Error(`Day ${this.day} must be between ${MIN_DAY} and ${MAX_DAY} inclusive`);
        }
      case Precision.MONTH:
        if (this.month < MIN_MONTH || this.month > MAX_MONTH) {
          throw new Error(`Month ${this.month} must be between ${MIN_MONTH} and ${MAX_MONTH} inclusive`);
        }
      case Precision.YEAR:
        if (this.year < MIN_YEAR || this.year > MAX_YEAR) {
          throw new Error(`Year ${this.year} must be between ${MIN_YEAR} and ${MAX_YEAR} inclusive`);
        }
    }

    if (this.precision > Precision.MONTH) {
      // check the days per month - first the general case
      if (this.day > DAYS_PER_MONTH[this.month]) {
        throw new Error(`Month ${this.month} has less than ${this.day} days`);
      }

      // now the special case for feb 29th and leap year
      if (this.month === 2 && this.day === 29) {
        if (!is_leapyear(this.year)) {
          throw new Error(`Given February 29th but year ${this.year} is not a leap year`);
        }
      }
    }
  }

  equals(expected : Timestamp) : boolean {//TODO implement instant equals https://github.com/amzn/ion-js/issues/132
    return this.getPrecision() === expected.getPrecision() && this.offset === expected.offset && this.dataModelEquals(expected);
  }

  dataModelEquals(expected : Timestamp) : boolean {
      switch (this.precision) {
          case Precision.NULL:
              return expected.precision === Precision.NULL;
          case Precision.SECONDS:
              if(this.seconds.comparedTo(expected.seconds) !== 0) return false;
          case Precision.HOUR_AND_MINUTE:
              if(this.minute !== expected.minute || this.hour !== expected.hour) return false;
          case Precision.DAY:
              if(this.day !== expected.day) return false;
          case Precision.MONTH:
              if(this.month !== expected.month) return false;
          case Precision.YEAR:
              if(this.year !== expected.year) return false;
      }
      return true;
  }

  stringValue() : string {
    let image: string;
    let t: Timestamp = this;

    switch (t.precision) {
      default: throw { msg: "invalid value for timestamp precision", where: "IonValueSupport.timestamp.toString" };
      case Precision.NULL:
        return "null.timestamp";
      case Precision.SECONDS:
        //formats decimal to timestamp second, adds a leading 0 and/or cuts off the trailing period
        image = t.seconds.toString();
        if(image.charAt(1)  === '.') image = "0" + image;
        if(image.charAt(image.length - 1) === '.') image = image.slice(0, image.length - 1);
      case Precision.HOUR_AND_MINUTE:
        image = _to_2_digits(t.minute) + (image ? ":" + image : "");
        image = _to_2_digits(t.hour) + (image ? ":" + image : "");
      case Precision.DAY:
        image = _to_2_digits(t.day) + (image ? "T" + image : "T");
      case Precision.MONTH:
        image = _to_2_digits(t.month) + (image ? "-" + image : "");
      case Precision.YEAR:
        if (t.precision === Precision.YEAR) {
          image = to_4_digits(t.year) + "T";
        } else if (t.precision === Precision.MONTH) {
          image = to_4_digits(t.year) + "-" + image + "T";
        } else {
          image = to_4_digits(t.year) + "-" + image;
        }
    }

    // hours : minute (for offset)
    let o: number = t.offset;
    if (t.precision > Precision.DAY || o === undefined) {  // TODO: is this right?
      if (o === undefined || o === -0.0) {
        image = image + "Z";
      } else {
        if (o < 0) {
          o = -o;
          image = image + "-";
        } else {
          image = image + "+";
        }
        image = image + _to_2_digits(Math.floor(o / 60));
        image = image + ":" + _to_2_digits(o % 60);
      }
    }
    return image;
  }

  toString() : string {
    return this.stringValue();
  }

  isNull() : boolean {
    return (this.precision === Precision.NULL);
  }

  getOffset() : number {
    return (this.precision > Precision.NULL) ? this.offset : null;
  }

  getPrecision() : Precision {
    return this.precision;
  }

    public getDate() : Date {
        let offsetShift = this.offset*60000, seconds = null, ms = null;
        if(this.precision === Precision.SECONDS) {
            let fraction = this.seconds.toNumber();
            seconds = Math.floor(fraction);
            ms = fraction - seconds;
        }
        let date = new Date(Date.UTC(this.year, (this.precision === Precision.YEAR ? 0 : this.month - 1), this.day, this.hour, this.minute, seconds, ms) - offsetShift);
        //The Ion specification allows year only precision, Javascript's Date does not, Ion has infinite precision decimal seconds whereas Javascript's Date rounds to milliseconds.
        //We have opted to allow users to generate Date objects within try catch statements so they can handle the specification differences as they see fit.
        //This is a one way lossy translation for user utility, do not use a Date to roundtrip data or expect any support for lossiness within the Date class and its APIs.
        if(this.precision === Precision.YEAR || this.precision === Precision.SECONDS) {
            let error =  new Error(this.precision === Precision.YEAR ? "Year" : "Seconds");
            error['date'] = date;
            throw error;
        }
        return date;
    }

  static readonly NULL: Timestamp = new Timestamp(Precision.NULL, null, null, null, null, null, null, null);

    static parse(str: string) : Timestamp {
        var precision;

        if (str.length < 1) return Timestamp.NULL;
        if (str.charCodeAt(0) === 110) {  // "n"
            if (str === "null") return Timestamp.NULL;
            if (str === "null.timestamp") return Timestamp.NULL;
            throw new Error("Illegal timestamp: " + str);
        }

        let offset: number = -0.0;
        let year: number = null;
        let month: number = null;
        let day: number = null;
        let hour: number = null;
        let minute: number = null;
        let seconds: BigNumber;

        let pos: number = 0;
        let state: TimeParserState = timeParserStates[States.YEAR];
        let limit: number = str.length;
        while (pos < limit) {
            switch (state.f) {
                case States.YEAR:
                    year = Number(str.substr( pos, state.len));
                    break;
                case States.MONTH:
                    month = Number(str.substr( pos, state.len));
                    break;
                case States.DAY:
                    day = Number(str.substr( pos, state.len));
                    break;
                case States.HOUR:
                    hour = Number(str.substr( pos, state.len));
                    break;
                case States.MINUTE:
                    minute = Number(str.substr( pos, state.len));
                    break;
                case States.SECONDS:
                    let digits: string = read_unknown_digits(str, pos);
                    if (digits.length === 0) throw new Error("No digits found at pos: " + pos);
                    pos += digits.length;
                    seconds = new BigNumber(digits);
                    break;
                case States.OFFSET:
                    break;
                case States.OFFSET_POSITIVE:
                    offset = Number(str.substr( pos, state.len)) * 60;
                    break;
                case States.OFFSET_NEGATIVE:
                    offset = Number(str.substr( pos, state.len)) * -60;
                    break;
                case States.OFFSET_MINUTES:
                    let min = Number(str.substr( pos, state.len));
                    offset += (offset < -0) ? -min : min;
                    if(min >= 60) throw new Error("Minute offset " + min + " above maximum or equal to : 60");
                    break;
                case States.OFFSET_ZULU:
                    offset = -0.0;
                    break;
                default:
                    throw new Error("Invalid internal state");
            }
            if (state.p !== undefined) {
                precision = state.p;
                if (pos >= limit) {
                    break;
                }
            }
            if (state.t !== undefined) {
                let c: string = String.fromCharCode(str.charCodeAt(pos));
                state = timeParserStates[state.t[c]];
                if (state === undefined) throw new Error("State was not set pos:" + pos );
            }
            pos++;
        }
        if(offset > MAX_OFFSET) throw new Error("Offset " + String(offset) + " above maximum: " + String(MAX_OFFSET));
        if(offset < MIN_OFFSET) throw new Error("Offset " + String(offset) + " below minimum: " + String(MIN_OFFSET));
        return new Timestamp(precision, offset, year, month, day, hour, minute, seconds);
    }
}