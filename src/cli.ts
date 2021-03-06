#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as meow from 'meow';
import * as parsers from 'term-schemes';
import {TermSchemes, TermScheme} from 'term-schemes';

const plist = require('plist');
const bplistParser = require('bplist-parser');
const fetch = require('node-fetch');
const getStdin = require('get-stdin');
const {render} = require('svg-term');
const sander = require('@marionebl/sander');

enum DetectableTerminals {
  iterm2 = 'iterm2',
  terminal = 'terminal'
};

interface Guesses {
  [key: string]: string | null;
}

interface SvgTermCli {
  flags: { [name: string]: any };
  help: string;
  input: string[];
}

interface SvgTermError extends Error {
  help: () => string;
}

withCli(main, `
  Usage
    $ svg-term [options]

  Options
    --cast          asciinema cast id to download [string], required if no stdin provided
    --out           output file, emits to stdout if omitted
    --profile       terminal profile file to use [file], requires --term
    --term          terminal profile format, requires [iterm2, xrdb, xresources, terminator, konsole, terminal, remmina, termite, tilda, xcfe] --profile
    --frame         wether to frame the result with an application window [boolean]
    --width         width in columns [number]
    --height        height in lines [number]
    --help          print this help [boolean]

  Examples
    $ echo rec.json | svg-term
    $ svg-term --cast 113643
`);

async function main(cli: SvgTermCli) {
  const input = await getInput(cli);
  const error = cliError(cli);
  
  if (!input) {
    throw error(`svg-term: either stdin or --cast are required`);
  }

  const malformed = ensure(['height', 'width'], cli.flags, (name, val) => {
    if (!(name in cli.flags)) {
      return;
    }
    const candidate = parseInt(val, 10);
    if (isNaN(candidate)) {
      return new TypeError(`${name} expected to be number, received "${val}"`);
    }
  });

  if (malformed.length > 0) {
    throw error(`svg-term: ${malformed.map(m => m.message).join('\n')}`);
  }

  const term = guessTerminal() || cli.flags.term;
  const profile = term ? guessProfile(term) || cli.flags.profile : cli.flags.profile;

  const guess: Guesses = {
    term,
    profile
  };

  if (('term' in cli.flags) || ('profile' in cli.flags)) {
    const unsatisfied = ['term', 'profile'].filter(n => !Boolean(guess[n]));

    if (unsatisfied.length > 0) {
      throw error(`svg-term: --term and --profile must be used together, ${unsatisfied.join(', ')} missing`);
    }
  }

  const unknown = ensure(['term'], cli.flags, (name, val) => {
    if (!(name in cli.flags)) {
      return;
    }
    if (!(cli.flags.term in TermSchemes)) {
      return new TypeError(`${name} expected to be one of ${Object.keys(TermSchemes).join(', ')}, received "${val}"`);
    }
  });

  if (unknown.length > 0) {
    throw error(`svg-term: ${unknown.map(m => m.message).join('\n')}`);
  }

  const p = guess.profile || '';
  const isFileProfile = ['~', '/', '.'].indexOf(p.charAt(0)) > -1;

  if (isFileProfile && 'profile' in cli.flags) {
    const missing = !fs.existsSync(path.join(process.cwd(), cli.flags.profile));
    if (missing) {
      throw error(`svg-term: ${cli.flags.profile} must be readable file but was not found`);
    }
  }

  const theme = getTheme(guess);

  const svg = render(input, {
    height: toNumber(cli.flags.height),
    theme,
    width: toNumber(cli.flags.width),
    window: Boolean(cli.flags.frame)
  });

  if ('out' in cli.flags) {
    sander.writeFile(cli.flags.out, Buffer.from(svg));
  } else {
    process.stdout.write(svg);
  }
}

function ensure(names: string[], flags: SvgTermCli['flags'], predicate: (name: string, val: any) => Error | null): Error[] {
  return names.map(name => predicate(name, flags[name])).filter(e => e instanceof Error);
}

function cliError(cli: SvgTermCli): (message: string) => SvgTermError {
  return (message: string): SvgTermError => {
    const err: any = new Error(message);
    err.help = () => cli.help; 
    return err;
  };
}

function getConfig(term: DetectableTerminals): any {
  switch(term) {
    case DetectableTerminals.terminal: {
      const file = sander.readFileSync(os.homedir(), `Library/Preferences/com.apple.terminal.plist`);
      return bplistParser.parseBuffer(file)[0];
    }
    case DetectableTerminals.iterm2: {
      const file = sander.readFileSync(os.homedir(), `Library/Preferences/com.googlecode.iterm2.plist`);
      return bplistParser.parseBuffer(file)[0];
    }
    default:
      return null;
  }
}

function getPresets(term: DetectableTerminals): any {
  const config = getConfig(term);

  switch(term) {
    case DetectableTerminals.terminal: {
      return config['Window Settings'];
    }
    case DetectableTerminals.iterm2: {
      return config['Custom Color Presets'];
    }
    default:
      return null;
  }
}

function guessProfile(term: DetectableTerminals): string | null {
  if (os.platform() !== 'darwin') {
    return null;
  }

  const config = getConfig(term);

  if (!config) {
    return null;
  }

  switch(term) {
    case DetectableTerminals.terminal: {
      return config['Default Window Settings'];
    }
    case DetectableTerminals.iterm2: {
      const presets = config['Custom Color Presets'];
    }
    default:
      return null;
  }
}

function guessTerminal(): DetectableTerminals | null {
  if (os.platform() !== 'darwin') {
    return;
  }

  switch(process.env.TERM_PROGRAM) {
    case 'iTerm.app':
      return DetectableTerminals.iterm2;
    case 'Apple_Terminal':
      return DetectableTerminals.terminal;
    default:
      return null;
  }
}

async function getInput(cli: SvgTermCli) {
  if (cli.flags.cast) {
    const response = await fetch(`https://asciinema.org/a/${cli.flags.cast}.cast?dl=true`);
    return response.text();
  }

  return await getStdin();  
}

function getParser(term: string) {
  switch(term) {
    case TermSchemes.iterm2:
      return parsers.iterm2;
    case TermSchemes.konsole:
      return parsers.konsole;
    case TermSchemes.remmina:
      return parsers.remmina;
    case TermSchemes.terminal:
      return parsers.terminal;
    case TermSchemes.terminator:
      return parsers.terminator;
    case TermSchemes.termite:
      return parsers.termite;
    case TermSchemes.tilda:
      return parsers.tilda;
    case TermSchemes.xcfe:
      return parsers.xfce;
    case TermSchemes.xresources:
      return parsers.xresources;
    case TermSchemes.xterm:
      return parsers.xterm;
    default:
      throw new Error(`unknown term parser: ${term}`);
  }
}

function getTheme(guess: Guesses): TermScheme | null {
  if (guess.term === null || guess.profile === null) {
    return null;
  }
  
  const p = guess.profile || '';
  const isFileProfile = ['~', '/', '.'].indexOf(p.charAt(0)) > -1;

  return isFileProfile 
    ? parseTheme(guess.term, guess.profile) 
    : extractTheme(guess.term, guess.profile);
}

function parseTheme(term: string, input: string): TermScheme {
  const parser = getParser(term);
  return parser(String(fs.readFileSync(input)));
}

function extractTheme(term: string, name: string): TermScheme | null {
  if (!(term in DetectableTerminals)) {
    return null;
  }

  if (os.platform() !== 'darwin') {
    return null;
  }

  const presets = getPresets(term as DetectableTerminals);
  const theme = presets[name];
  const parser = getParser(term);

  if (!theme) {
    return null;
  }

  switch (term) {
    case DetectableTerminals.iterm2: {
      return parser(plist.build(theme));
    }
    case DetectableTerminals.terminal:
      return parser(plist.build(theme));
    default:
      return null;
  }
}

function toNumber(input: string | null): number | null {
  if (!input) {
    return null;
  }
  const candidate = parseInt(input, 10);
  if (isNaN(candidate)) {
    return null;
  }
  return candidate;
}

function withCli(fn: (cli: SvgTermCli) => Promise<void>, help: string = ''): Promise<void> {
  return main(meow(help))
    .catch(err => {
      setTimeout(() => {
        if (typeof err.help === 'function') {
          console.log(err.help());
          console.log('\n', err.message);
          process.exit(1);
        }
        throw err;
      }, 0);
    });
}