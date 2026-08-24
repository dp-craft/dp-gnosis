import { homedir } from 'node:os';

import { cacheHome, configHome, dataHome, stateHome } from '../src/env.js';

const EMPTY: NodeJS.ProcessEnv = {};
const HOME = homedir();

describe('env — user directory resolution', () => {
  describe('linux defaults', () => {
    it('uses the XDG fallback tree suffixed with the app dir', () => {
      expect(configHome(EMPTY, 'linux')).toBe(`${HOME}/.config/gnosis`);
      expect(dataHome(EMPTY, 'linux')).toBe(`${HOME}/.local/share/gnosis`);
      expect(cacheHome(EMPTY, 'linux')).toBe(`${HOME}/.cache/gnosis`);
      expect(stateHome(EMPTY, 'linux')).toBe(`${HOME}/.local/state/gnosis`);
    });

    it('honours the XDG variables when they are set', () => {
      const env: NodeJS.ProcessEnv = {
        XDG_CONFIG_HOME: '/x/cfg',
        XDG_DATA_HOME: '/x/data',
        XDG_CACHE_HOME: '/x/cache',
        XDG_STATE_HOME: '/x/state'
      };
      expect(configHome(env, 'linux')).toBe('/x/cfg/gnosis');
      expect(dataHome(env, 'linux')).toBe('/x/data/gnosis');
      expect(cacheHome(env, 'linux')).toBe('/x/cache/gnosis');
      expect(stateHome(env, 'linux')).toBe('/x/state/gnosis');
    });

    it('treats an unknown platform as linux', () => {
      expect(configHome(EMPTY, 'freebsd')).toBe(`${HOME}/.config/gnosis`);
      expect(stateHome(EMPTY, 'freebsd')).toBe(`${HOME}/.local/state/gnosis`);
    });
  });

  describe('darwin defaults', () => {
    it('uses the Apple convention for all four', () => {
      expect(configHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Application Support/gnosis`);
      expect(dataHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Application Support/gnosis`);
      expect(cacheHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Caches/gnosis`);
      expect(stateHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Logs/gnosis`);
    });

    it('lets a set XDG variable win over the Apple default', () => {
      const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: '/opt/xdg-data' };
      expect(dataHome(env, 'darwin')).toBe('/opt/xdg-data/gnosis');
      expect(cacheHome(env, 'darwin')).toBe(`${HOME}/Library/Caches/gnosis`);
    });
  });

  describe('win32 defaults', () => {
    it('falls back to the AppData tree when the variables are unset', () => {
      expect(configHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Roaming/gnosis`);
      expect(dataHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Roaming/gnosis`);
      expect(cacheHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Local/gnosis`);
      expect(stateHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Local/gnosis`);
    });

    it('reads APPDATA for config/data and LOCALAPPDATA for cache/state', () => {
      const env: NodeJS.ProcessEnv = { APPDATA: '/r', LOCALAPPDATA: '/l' };
      expect(configHome(env, 'win32')).toBe('/r/gnosis');
      expect(dataHome(env, 'win32')).toBe('/r/gnosis');
      expect(cacheHome(env, 'win32')).toBe('/l/gnosis');
      expect(stateHome(env, 'win32')).toBe('/l/gnosis');
    });
  });

  describe('gnosis-specific overrides', () => {
    it('outranks both the XDG variable and the platform default', () => {
      const env: NodeJS.ProcessEnv = {
        GNOSIS_CONFIG_HOME: '/g/cfg',
        GNOSIS_DATA_HOME: '/g/data',
        GNOSIS_CACHE_HOME: '/g/cache',
        GNOSIS_STATE_HOME: '/g/state',
        XDG_CONFIG_HOME: '/x/cfg',
        XDG_DATA_HOME: '/x/data',
        XDG_CACHE_HOME: '/x/cache',
        XDG_STATE_HOME: '/x/state',
        APPDATA: '/r',
        LOCALAPPDATA: '/l'
      };
      expect(configHome(env, 'linux')).toBe('/g/cfg/gnosis');
      expect(dataHome(env, 'darwin')).toBe('/g/data/gnosis');
      expect(cacheHome(env, 'win32')).toBe('/g/cache/gnosis');
      expect(stateHome(env, 'linux')).toBe('/g/state/gnosis');
    });
  });

  describe('empty and whitespace values are unset, never ""', () => {
    it('ignores an empty XDG variable instead of resolving to /gnosis', () => {
      expect(dataHome({ XDG_DATA_HOME: '' }, 'linux')).toBe(`${HOME}/.local/share/gnosis`);
      expect(cacheHome({ XDG_CACHE_HOME: '   ' }, 'linux')).toBe(`${HOME}/.cache/gnosis`);
    });

    it('ignores an empty gnosis override and falls through to the platform default', () => {
      const env: NodeJS.ProcessEnv = { GNOSIS_CONFIG_HOME: '  ', XDG_CONFIG_HOME: '/x/cfg' };
      expect(configHome(env, 'linux')).toBe('/x/cfg/gnosis');
    });

    it('ignores an empty APPDATA', () => {
      expect(configHome({ APPDATA: '' }, 'win32')).toBe(`${HOME}/AppData/Roaming/gnosis`);
    });
  });

  describe('a relative path is refused, by name', () => {
    it('throws naming the XDG variable and its value', () => {
      expect(() => dataHome({ XDG_DATA_HOME: 'relative/data' }, 'linux')).toThrow(
        /XDG_DATA_HOME.*relative\/data/
      );
    });

    it('refuses a relative value on every platform-specific variable', () => {
      expect(() => configHome({ XDG_CONFIG_HOME: './cfg' }, 'darwin')).toThrow(/XDG_CONFIG_HOME/);
      expect(() => cacheHome({ LOCALAPPDATA: 'AppData/Local' }, 'win32')).toThrow(/LOCALAPPDATA/);
      expect(() => stateHome({ GNOSIS_STATE_HOME: '../state' }, 'linux')).toThrow(
        /GNOSIS_STATE_HOME/
      );
    });

    it('MUST NOT resolve a relative value against cwd', () => {
      expect(() => dataHome({ XDG_DATA_HOME: 'relative/data' }, 'linux')).toThrow();
    });
  });

  describe('home expansion', () => {
    it('anchors every default on the real home directory', () => {
      const defaults = [
        configHome(EMPTY, 'linux'),
        dataHome(EMPTY, 'darwin'),
        cacheHome(EMPTY, 'win32'),
        stateHome(EMPTY, 'linux')
      ];
      expect(defaults.every(p => p.startsWith(`${HOME}/`))).toBe(true);
      expect(defaults.some(p => p.startsWith('~'))).toBe(false);
    });
  });

  describe('purity', () => {
    it('re-reads the environment on every call rather than freezing it at import', () => {
      expect(dataHome({ GNOSIS_DATA_HOME: '/first' }, 'linux')).toBe('/first/gnosis');
      expect(dataHome({ GNOSIS_DATA_HOME: '/second' }, 'linux')).toBe('/second/gnosis');
    });
  });
});
