/**
 * term.js - an xterm emulator
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * https://github.com/chjj/term.js
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 *   The original design remains. The terminal itself
 *   has been extended to include xterm CSI codes, among
 *   other features.
 */

;(function() {

/**
 * Terminal Emulation References:
 *   http://vt100.net/
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.txt
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 *   http://invisible-island.net/vttest/
 *   http://www.inwap.com/pdp10/ansicode.txt
 *   http://linux.die.net/man/4/console_codes
 *   http://linux.die.net/man/7/urxvt
 */

'use strict';

/**
 * Shared
 */

var window = this
  , document = this.document;

/**
 * EventEmitter
 */

function EventEmitter() {
  this._events = this._events || {};
}

EventEmitter.prototype.addListener = function(type, listener) {
  this._events[type] = this._events[type] || [];
  this._events[type].push(listener);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.removeListener = function(type, listener) {
  if (!this._events[type]) return;

  var obj = this._events[type]
    , i = obj.length;

  while (i--) {
    if (obj[i] === listener || obj[i].listener === listener) {
      obj.splice(i, 1);
      return;
    }
  }
};

EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function(type) {
  if (this._events[type]) delete this._events[type];
};

EventEmitter.prototype.once = function(type, listener) {
  function on() {
    var args = Array.prototype.slice.call(arguments);
    this.removeListener(type, on);
    return listener.apply(this, args);
  }
  on.listener = listener;
  return this.on(type, on);
};

EventEmitter.prototype.emit = function(type) {
  if (!this._events[type]) return;

  var args = Array.prototype.slice.call(arguments, 1)
    , obj = this._events[type]
    , l = obj.length
    , i = 0;

  for (; i < l; i++) {
    obj[i].apply(this, args);
  }
};

EventEmitter.prototype.listeners = function(type) {
  return this._events[type] = this._events[type] || [];
};

/**
 * Stream
 */

function Stream() {
  EventEmitter.call(this);
}

inherits(Stream, EventEmitter);

Stream.prototype.pipe = function(dest, options) {
  var src = this
    , ondata
    , onerror
    , onend;

  function unbind() {
    src.removeListener('data', ondata);
    src.removeListener('error', onerror);
    src.removeListener('end', onend);
    dest.removeListener('error', onerror);
    dest.removeListener('close', unbind);
  }

  src.on('data', ondata = function(data) {
    dest.write(data);
  });

  src.on('error', onerror = function(err) {
    unbind();
    if (!this.listeners('error').length) {
      throw err;
    }
  });

  src.on('end', onend = function() {
    dest.end();
    unbind();
  });

  dest.on('error', onerror);
  dest.on('close', unbind);

  dest.emit('pipe', src);

  return dest;
};

/**
 * States
 */

var normal = 0
  , escaped = 1
  , csi = 2
  , osc = 3
  , charset = 4
  , dcs = 5
  , ignore = 6
  , UDK = { type: 'udk' };

/**
 * Terminal
 */

function Terminal(options) {
  var self = this;

  if (!(this instanceof Terminal)) {
    return new Terminal(arguments[0], arguments[1], arguments[2]);
  }

  Stream.call(this);

  if (typeof options === 'number') {
    options = {
      cols: arguments[0],
      rows: arguments[1],
      handler: arguments[2]
    };
  }

  options = options || {};

  each(keys(Terminal.defaults), function(key) {
    if (options[key] == null) {
      options[key] = Terminal.options[key];
      // Legacy:
      if (Terminal[key] !== Terminal.defaults[key]) {
        options[key] = Terminal[key];
      }
    }
    self[key] = options[key];
  });

  if (options.colors.length === 8) {
    options.colors = options.colors.concat(Terminal._colors.slice(8));
  } else if (options.colors.length === 16) {
    options.colors = options.colors.concat(Terminal._colors.slice(16));
  } else if (options.colors.length === 10) {
    options.colors = options.colors.slice(0, -2).concat(
      Terminal._colors.slice(8, -2), options.colors.slice(-2));
  } else if (options.colors.length === 18) {
    options.colors = options.colors.slice(0, -2).concat(
      Terminal._colors.slice(16, -2), options.colors.slice(-2));
  }
  this.colors = options.colors;

  this.options = options;

  // this.context = options.context || window;
  // this.document = options.document || document;
  this.parent = options.body || options.parent
    || (document ? document.getElementsByTagName('body')[0] : null);

  this.cols = options.cols || options.geometry[0];
  this.rows = options.rows || options.geometry[1];

  // Act as though we are a node TTY stream:
  this.setRawMode;
  this.isTTY = true;
  this.isRaw = true;
  this.columns = this.cols;
  this.rows = this.rows;

  if (options.handler) {
    this.on('data', options.handler);
  }

  this.ybase = 0;
  this.ydisp = 0;
  this.x = 0;
  this.y = 0;
  this.cursorState = 0;
  this.cursorHidden = false;
  this.convertEol;
  this.state = 0;
  this.queue = '';
  this.scrollTop = 0;
  this.scrollBottom = this.rows - 1;

  // modes
  this.applicationKeypad = false;
  this.applicationCursor = false;
  this.originMode = false;
  this.insertMode = false;
  this.wraparoundMode = false;
  this.normal = null;

  // select modes
  this.prefixMode = false;
  this.selectMode = false;
  this.visualMode = false;
  this.searchMode = false;
  this.searchDown;
  this.entry = '';
  this.entryPrefix = 'Search: ';
  this._real;
  this._selected;
  this._textarea;

  // charset
  this.charset = null;
  this.gcharset = null;
  this.glevel = 0;
  this.charsets = [null];

  // mouse properties
  this.decLocator;
  this.x10Mouse;
  this.vt200Mouse;
  this.vt300Mouse;
  this.normalMouse;
  this.mouseEvents;
  this.sendFocus;
  this.utfMouse;
  this.sgrMouse;
  this.urxvtMouse;

  // misc
  this.element;
  this.children;
  this.refreshStart;
  this.refreshEnd;
  this.savedX;
  this.savedY;
  this.savedCols;

  // stream
  this.readable = true;
  this.writable = true;

  this.defAttr = (0 << 18) | (257 << 9) | (256 << 0);
  this.curAttr = this.defAttr;

  this.params = [];
  this.currentParam = 0;
  this.prefix = '';
  this.postfix = '';

  this.lines = [];
  var i = this.rows;
  while (i--) {
    this.lines.push(this.blankLine());
  }

  this.tabs;
  this.setupStops();
}

inherits(Terminal, Stream);

/**
 * Colors
 */

// Colors 0-15
Terminal.tangoColors = [
  // dark:
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  // bright:
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec'
];

Terminal.xtermColors = [
  // dark:
  '#000000', // black
  '#cd0000', // red3
  '#00cd00', // green3
  '#cdcd00', // yellow3
  '#0000ee', // blue2
  '#cd00cd', // magenta3
  '#00cdcd', // cyan3
  '#e5e5e5', // gray90
  // bright:
  '#7f7f7f', // gray50
  '#ff0000', // red
  '#00ff00', // green
  '#ffff00', // yellow
  '#5c5cff', // rgb:5c/5c/ff
  '#ff00ff', // magenta
  '#00ffff', // cyan
  '#ffffff'  // white
];

// Colors 0-15 + 16-255
// Much thanks to TooTallNate for writing this.
Terminal.colors = (function() {
  var colors = Terminal.tangoColors.slice()
    , r = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
    , i;

  // 16-231
  i = 0;
  for (; i < 216; i++) {
    out(r[(i / 36) % 6 | 0], r[(i / 6) % 6 | 0], r[i % 6]);
  }

  // 232-255 (grey)
  i = 0;
  for (; i < 24; i++) {
    r = 8 + i * 10;
    out(r, r, r);
  }

  function out(r, g, b) {
    colors.push('#' + hex(r) + hex(g) + hex(b));
  }

  function hex(c) {
    c = c.toString(16);
    return c.length < 2 ? '0' + c : c;
  }

  return colors;
})();

// Default BG/FG
Terminal.colors[256] = '#000000';
Terminal.colors[257] = '#f0f0f0';

Terminal._colors = Terminal.colors.slice();

Terminal.vcolors = (function() {
  var out = []
    , colors = Terminal.colors
    , i = 0
    , color;

  for (; i < 256; i++) {
    color = parseInt(colors[i].substring(1), 16);
    out.push([
      (color >> 16) & 0xff,
      (color >> 8) & 0xff,
      color & 0xff
    ]);
  }

  return out;
})();

/**
 * Options
 */

Terminal.defaults = {
  colors: Terminal.colors,
  convertEol: false,
  termName: 'xterm',
  geometry: [80, 24],
  cursorBlink: true,
  visualBell: false,
  popOnBell: false,
  scrollback: 1000,
  screenKeys: false,
  debug: false,
  useStyle: false
  // programFeatures: false,
  // focusKeys: false,
};

Terminal.options = {};

each(keys(Terminal.defaults), function(key) {
  Terminal[key] = Terminal.defaults[key];
  Terminal.options[key] = Terminal.defaults[key];
});

/**
 * Focused Terminal
 */

Terminal.focus = null;

Terminal.prototype.focus = function() {
  if (Terminal.focus === this) return;

  if (Terminal.focus) {
    Terminal.focus.blur();
  }

  if (this.sendFocus) this.send('\x1b[I');
  this.showCursor();

  Terminal.focus = this;
};

Terminal.prototype.blur = function() {
  if (Terminal.focus !== this) return;

  this.cursorState = 0;
  this.refresh(this.y, this.y);
  if (this.sendFocus) this.send('\x1b[O');

  Terminal.focus = null;
};

/**
 * Initialize global behavior
 */

Terminal.prototype.initGlobal = function() {
  var document = this.document;

  Terminal._boundDocs = Terminal._boundDocs || [];
  if (~indexOf(Terminal._boundDocs, document)) {
    return;
  }
  Terminal._boundDocs.push(document);

  Terminal.bindPaste(document);

  Terminal.bindKeys(document);

  Terminal.bindCopy(document);

  if (this.isMobile) {
    this.fixMobile(document);
  }

  if (this.useStyle) {
    Terminal.insertStyle(document, this.colors[256], this.colors[257]);
  }
};

/**
 * Bind to paste event
 */

Terminal.bindPaste = function(document) {
  // This seems to work well for ctrl-V and middle-click,
  // even without the contentEditable workaround.
  var window = document.defaultView;
  on(window, 'paste', function(ev) {
    var term = Terminal.focus;
    if (!term) return;
    if (ev.clipboardData) {
      term.send(ev.clipboardData.getData('text/plain'));
    } else if (term.context.clipboardData) {
      term.send(term.context.clipboardData.getData('Text'));
    }
    // Not necessary. Do it anyway for good measure.
    term.element.contentEditable = 'inherit';
    return cancel(ev);
  });
};

/**
 * Global Events for key handling
 */

Terminal.bindKeys = function(document) {
  on(document, 'keydown', function(ev) {
    if (!Terminal.focus) return;
    var target = ev.target || ev.srcElement;
    if (!target) return;
    if (target === Terminal.focus.element
        || target === Terminal.focus.context
        || target === Terminal.focus.document
        || target === Terminal.focus.body
        || target === Terminal._textarea
        || target === Terminal.focus.parent) {
      return Terminal.focus.keyDown(ev);
    }
  }, true);

  on(document, 'keypress', function(ev) {
    if (!Terminal.focus) return;
    var target = ev.target || ev.srcElement;
    if (!target) return;
    if (ev.ctrlKey && ev.key === 'v') {
      return;
    }
    if (target === Terminal.focus.element
        || target === Terminal.focus.context
        || target === Terminal.focus.document
        || target === Terminal.focus.body
        || target === Terminal._textarea
        || target === Terminal.focus.parent) {
      Terminal.focus.element.contentEditable = 'inherit';
      return Terminal.focus.keyPress(ev);
    }
  }, true);

  on(document, 'mousedown', function(ev) {
    if (!Terminal.focus) return;

    var el = ev.target || ev.srcElement;
    if (!el) return;

    do {
      if (el === Terminal.focus.element) return;
    } while (el = el.parentNode);

    Terminal.focus.blur();
  });
};

/**
 * Copy Selection w/ Ctrl-C (Select Mode)
 */

Terminal.bindCopy = function(document) {
  var window = document.defaultView;
  on(window, 'copy', function(ev) {
    var term = Terminal.focus;
    if (!term) return;
    if (!term._selected) return;
    var textarea = term.getCopyTextarea();
    var text = term.grabText(
      term._selected.x1, term._selected.x2,
      term._selected.y1, term._selected.y2);
    term.emit('copy', text);
    textarea.focus();
    textarea.textContent = text;
    textarea.value = text;
    textarea.setSelectionRange(0, text.length);
    setTimeout(function() {
      term.element.focus();
      term.focus();
    }, 1);
  });
};

/**
 * Fix Mobile
 */

Terminal.prototype.fixMobile = function(document) {
  var self = this;

  var textarea = document.createElement('textarea');
  textarea.style.position = 'absolute';
  textarea.style.left = '-32000px';
  textarea.style.top = '-32000px';
  textarea.style.width = '0px';
  textarea.style.height = '0px';
  textarea.style.opacity = '0';
  textarea.style.backgroundColor = 'transparent';
  textarea.style.borderStyle = 'none';
  textarea.style.outlineStyle = 'none';
  textarea.autocapitalize = 'none';
  textarea.autocorrect = 'off';

  document.getElementsByTagName('body')[0].appendChild(textarea);

  Terminal._textarea = textarea;

  setTimeout(function() {
    textarea.focus();
  }, 1000);

  if (this.isAndroid) {
    on(textarea, 'change', function() {
      var value = textarea.textContent || textarea.value;
      textarea.value = '';
      textarea.textContent = '';
      self.send(value + '\r');
    });
  }
};

/**
 * Insert a default style
 */

Terminal.insertStyle = function(document, bg, fg) {
  var style = document.getElementById('term-style');
  if (style) return;

  var head = document.getElementsByTagName('head')[0];
  if (!head) return;

  var style = document.createElement('style');
  style.id = 'term-style';

  // textContent doesn't work well with IE for <style> elements.
  style.innerHTML = ''
    + '.terminal {\n'
    + '  float: left;\n'
    + '  border: ' + bg + ' solid 5px;\n'
    + '  font-family: "DejaVu Sans Mono", "Liberation Mono", monospace;\n'
    + '  font-size: 15px;\n'
    + '  color: ' + fg + ';\n'
    + '  background: ' + bg + ';\n'
    + '}\n'
    + '\n'
    + '.terminal-cursor {\n'
    + '  color: ' + bg + ';\n'
    + '  background: ' + fg + ';\n'
    + '}\n';

  head.insertBefore(style, head.firstChild);
};

/**
 * Open Terminal
 */

Terminal.prototype.open = function(parent) {
  var self = this
    , i = 0
    , div;

  this.parent = parent || this.parent;

  if (!this.parent) {
    throw new Error('Terminal requires a parent element.');
  }

  // Grab global elements.
  this.context = this.parent.ownerDocument.defaultView;
  this.document = this.parent.ownerDocument;
  this.body = this.document.getElementsByTagName('body')[0];

  // Parse user-agent strings.
  if (this.context.navigator && this.context.navigator.userAgent) {
    this.isMac = !!~this.context.navigator.userAgent.indexOf('Mac');
    this.isIpad = !!~this.context.navigator.userAgent.indexOf('iPad');
    this.isIphone = !!~this.context.navigator.userAgent.indexOf('iPhone');
    this.isAndroid = !!~this.context.navigator.userAgent.indexOf('Android');
    this.isMobile = this.isIpad || this.isIphone || this.isAndroid;
    this.isMSIE = !!~this.context.navigator.userAgent.indexOf('MSIE');
    this.isFirefox = !!~this.context.navigator.userAgent.indexOf('Firefox');
  }

  // Create our main terminal element.
  this.element = this.document.createElement('div');
  this.element.className = 'terminal';
  this.element.style.outline = 'none';
  this.element.setAttribute('tabindex', 0);
  this.element.setAttribute('spellcheck', 'false');
  this.element.style.backgroundColor = this.colors[256];
  this.element.style.color = this.colors[257];

  // Create the lines for our terminal.
  this.children = [];
  for (; i < this.rows; i++) {
    div = this.document.createElement('div');
    this.element.appendChild(div);
    this.children.push(div);
  }
  this.parent.appendChild(this.element);

  // Draw the screen.
  this.refresh(0, this.rows - 1);

  if (!('useEvents' in this.options) || this.options.useEvents) {
    // Initialize global actions that
    // need to be taken on the document.
    this.initGlobal();
  }

  if (!('useFocus' in this.options) || this.options.useFocus) {
    // Ensure there is a Terminal.focus.
    this.focus();

    // Start blinking the cursor.
    this.startBlink();

    // Bind to DOM events related
    // to focus and paste behavior.
    on(this.element, 'focus', function() {
      self.focus();
      if (self.isMobile) {
        Terminal._textarea.focus();
      }
    });

    on(this.element, 'mousedown', function() {
      self.focus();
    });

    on(this.element, 'mousedown', function(ev) {
      var button = ev.button != null
        ? +ev.button
        : ev.which != null
          ? ev.which - 1
          : null;

      // Does IE9 do this?
      if (self.isMSIE) {
        button = button === 1 ? 0 : button === 4 ? 1 : button;
      }

      // We care about middle mouse button (paste) and right button (context menu with paste)
      if (button !== 1 && button !== 2) {
        self.element.contentEditable = 'inherit';
        return;
      }

      // Required for various browsers to actually show "Paste" in context menu
      self.element.contentEditable = 'true';

      if (self.isFirefox) {
        // At least try to place caret (which is shown for contentEditable)
        // to a known position.
        window.getSelection().collapse(self.element, 0);
      }
      // with Firefox.
      if (!self.isFirefox) {
        setTimeout(function() {
          self.element.contentEditable = 'inherit'; // 'false';
        }, 1);
      }
    }, true);
  }

  if (!('useMouse' in this.options) || this.options.useMouse) {
    // Listen for mouse events and translate
    // them into terminal mouse protocols.
    this.bindMouse();
  }

  // this.emit('open');

  if (!('useFocus' in this.options) || this.options.useFocus) {
      // This can be useful for pasting,
      // as well as the iPad fix.
      setTimeout(function() {
        self.element.focus();
      }, 100);
  }

  // Figure out whether boldness affects
  // the character width of monospace fonts.
  if (Terminal.brokenBold == null) {
    Terminal.brokenBold = isBoldBroken(this.document);
  }

  this.emit('open');
};

Terminal.prototype.setRawMode = function(value) {
  this.isRaw = !!value;
};

Terminal.prototype.bindMouse = function() {
  var el = this.element
    , self = this
    , pressed = 32;

  var wheelEvent = 'onmousewheel' in this.context
    ? 'mousewheel'
    : 'DOMMouseScroll';

  function sendButton(ev) {
    var button
      , pos;

    // get the xterm-style button
    button = getButton(ev);

    // get mouse coordinates
    pos = getCoords(ev);
    if (!pos) return;

    sendEvent(button, pos);

    switch (ev.type) {
      case 'mousedown':
        pressed = button;
        break;
      case 'mouseup':
        pressed = 32;
        break;
      case wheelEvent:
        break;
    }
  }

  function sendMove(ev) {
    var button = pressed
      , pos;

    pos = getCoords(ev);
    if (!pos) return;
    button += 32;

    sendEvent(button, pos);
  }

  function encode(data, ch) {
    if (!self.utfMouse) {
      if (ch === 255) return data.push(0);
      if (ch > 127) ch = 127;
      data.push(ch);
    } else {
      if (ch === 2047) return data.push(0);
      if (ch < 127) {
        data.push(ch);
      } else {
        if (ch > 2047) ch = 2047;
        data.push(0xC0 | (ch >> 6));
        data.push(0x80 | (ch & 0x3F));
      }
    }
  }

  function sendEvent(button, pos) {

    if (self.vt300Mouse) {
      // NOTE: Unstable.
      // http://www.vt100.net/docs/vt3xx-gp/chapter15.html
      button &= 3;
      pos.x -= 32;
      pos.y -= 32;
      var data = '\x1b[24';
      if (button === 0) data += '1';
      else if (button === 1) data += '3';
      else if (button === 2) data += '5';
      else if (button === 3) return;
      else data += '0';
      data += '~[' + pos.x + ',' + pos.y + ']\r';
      self.send(data);
      return;
    }

    if (self.decLocator) {
      // NOTE: Unstable.
      button &= 3;
      pos.x -= 32;
      pos.y -= 32;
      if (button === 0) button = 2;
      else if (button === 1) button = 4;
      else if (button === 2) button = 6;
      else if (button === 3) button = 3;
      self.send('\x1b['
        + button
        + ';'
        + (button === 3 ? 4 : 0)
        + ';'
        + pos.y
        + ';'
        + pos.x
        + ';'
        + (pos.page || 0)
        + '&w');
      return;
    }

    if (self.urxvtMouse) {
      pos.x -= 32;
      pos.y -= 32;
      pos.x++;
      pos.y++;
      self.send('\x1b[' + button + ';' + pos.x + ';' + pos.y + 'M');
      return;
    }

    if (self.sgrMouse) {
      pos.x -= 32;
      pos.y -= 32;
      self.send('\x1b[<'
        + ((button & 3) === 3 ? button & ~3 : button)
        + ';'
        + pos.x
        + ';'
        + pos.y
        + ((button & 3) === 3 ? 'm' : 'M'));
      return;
    }

    var data = [];

    encode(data, button);
    encode(data, pos.x);
    encode(data, pos.y);

    self.send('\x1b[M' + String.fromCharCode.apply(String, data));
  }

  function getButton(ev) {
    var button
      , shift
      , meta
      , ctrl
      , mod;

    switch (ev.type) {
      case 'mousedown':
        button = ev.button != null
          ? +ev.button
          : ev.which != null
            ? ev.which - 1
            : null;

        if (self.isMSIE) {
          button = button === 1 ? 0 : button === 4 ? 1 : button;
        }
        break;
      case 'mouseup':
        button = 3;
        break;
      case 'DOMMouseScroll':
        button = ev.detail < 0
          ? 64
          : 65;
        break;
      case 'mousewheel':
        button = ev.wheelDeltaY > 0
          ? 64
          : 65;
        break;
    }

    shift = ev.shiftKey ? 4 : 0;
    meta = ev.metaKey ? 8 : 0;
    ctrl = ev.ctrlKey ? 16 : 0;
    mod = shift | meta | ctrl;

    // no mods
    if (self.vt200Mouse) {
      // ctrl only
      mod &= ctrl;
    } else if (!self.normalMouse) {
      mod = 0;
    }

    // increment to SP
    button = (32 + (mod << 2)) + button;

    return button;
  }

  // mouse coordinates measured in cols/rows
  function getCoords(ev) {
    var x, y, w, h, el;

    // ignore browsers without pageX for now
    if (ev.pageX == null) return;

    x = ev.pageX;
    y = ev.pageY;
    el = self.element;

    // should probably check offsetParent
    // but this is more portable
    while (el && el !== self.document.documentElement) {
      x -= el.offsetLeft;
      y -= el.offsetTop;
      el = 'offsetParent' in el
        ? el.offsetParent
        : el.parentNode;
    }

    // convert to cols/rows
    w = self.element.clientWidth;
    h = self.element.clientHeight;
    x = Math.round((x / w) * self.cols);
    y = Math.round((y / h) * self.rows);

    // be sure to avoid sending
    // bad positions to the program
    if (x < 0) x = 0;
    if (x > self.cols) x = self.cols;
    if (y < 0) y = 0;
    if (y > self.rows) y = self.rows;

    // xterm sends raw bytes and
    // starts at 32 (SP) for each.
    x += 32;
    y += 32;

    return {
      x: x,
      y: y,
      type: ev.type === wheelEvent
        ? 'mousewheel'
        : ev.type
    };
  }

  on(el, 'mousedown', function(ev) {
    if (!self.mouseEvents) return;

    // send the button
    sendButton(ev);

    // ensure focus
    self.focus();
    if (self.normalMouse) on(self.document, 'mousemove', sendMove);

    // x10 compatibility mode can't send button releases
    if (!self.x10Mouse) {
      on(self.document, 'mouseup', function up(ev) {
        sendButton(ev);
        if (self.normalMouse) off(self.document, 'mousemove', sendMove);
        off(self.document, 'mouseup', up);
        return cancel(ev);
      });
    }

    return cancel(ev);
  });

  on(el, wheelEvent, function(ev) {
    if (!self.mouseEvents) return;
    if (self.x10Mouse
        || self.vt300Mouse
        || self.decLocator) return;
    sendButton(ev);
    return cancel(ev);
  });

  // allow mousewheel scrolling in
  // the shell for example
  on(el, wheelEvent, function(ev) {
    if (self.mouseEvents) return;
    if (self.applicationKeypad) return;
    if (ev.type === 'DOMMouseScroll') {
      self.scrollDisp(ev.detail < 0 ? -5 : 5);
    } else {
      self.scrollDisp(ev.wheelDeltaY > 0 ? -5 : 5);
    }
    return cancel(ev);
  });
};

/**
 * Destroy Terminal
 */

Terminal.prototype.close =
Terminal.prototype.destroySoon =
Terminal.prototype.destroy = function() {
  if (this.destroyed) {
    return;
  }

  if (this._blink) {
    clearInterval(this._blink);
    delete this._blink;
  }

  this.readable = false;
  this.writable = false;
  this.destroyed = true;
  this._events = {};

  this.handler = function() {};
  this.write = function() {};
  this.end = function() {};

  if (this.element.parentNode) {
    this.element.parentNode.removeChild(this.element);
  }

  this.emit('end');
  this.emit('close');
  this.emit('finish');
  this.emit('destroy');
};

Terminal.prototype.refresh = function(start, end) {
  var x
    , y
    , i
    , line
    , out
    , ch
    , width
    , data
    , attr
    , bg
    , fg
    , flags
    , row
    , parent;

  if (end - start >= this.rows / 2) {
    parent = this.element.parentNode;
    if (parent) parent.removeChild(this.element);
  }

  width = this.cols;
  y = start;

  if (end >= this.lines.length) {
    this.log('`end` is too large. Most likely a bad CSR.');
    end = this.lines.length - 1;
  }

  for (; y <= end; y++) {
    row = y + this.ydisp;

    line = this.lines[row];
    out = '';

    if (y === this.y
        && this.cursorState
        && (this.ydisp === this.ybase || this.selectMode)
        && !this.cursorHidden) {
      x = this.x;
    } else {
      x = -1;
    }

    attr = this.defAttr;
    i = 0;

    for (; i < width; i++) {
      data = line[i][0];
      ch = line[i][1];

      if (i === x) data = -1;

      if (data !== attr) {
        if (attr !== this.defAttr) {
          out += '</span>';
        }
        if (data !== this.defAttr) {
          if (data === -1) {
            out += '<span class="reverse-video terminal-cursor">';
          } else {
            out += '<span style="';

            bg = data & 0x1ff;
            fg = (data >> 9) & 0x1ff;
            flags = data >> 18;

            // bold
            if (flags & 1) {
              if (!Terminal.brokenBold) {
                out += 'font-weight:bold;';
              }
              // See: XTerm*boldColors
              if (fg < 8) fg += 8;
            }

            // underline
            if (flags & 2) {
              out += 'text-decoration:underline;';
            }

            // blink
            if (flags & 4) {
              if (flags & 2) {
                out = out.slice(0, -1);
                out += ' blink;';
              } else {
                out += 'text-decoration:blink;';
              }
            }

            // inverse
            if (flags & 8) {
              bg = (data >> 9) & 0x1ff;
              fg = data & 0x1ff;
              // Should inverse just be before the
              // above boldColors effect instead?
              if ((flags & 1) && fg < 8) fg += 8;
            }

            // invisible
            if (flags & 16) {
              out += 'visibility:hidden;';
            }

            if (bg !== 256) {
              out += 'background-color:'
                + this.colors[bg]
                + ';';
            }

            if (fg !== 257) {
              out += 'color:'
                + this.colors[fg]
                + ';';
            }

            out += '">';
          }
        }
      }

      switch (ch) {
        case '&':
          out += '&amp;';
          break;
        case '<':
          out += '&lt;';
          break;
        case '>':
          out += '&gt;';
          break;
        default:
          if (ch <= ' ') {
            out += '&nbsp;';
          } else {
            if (isWide(ch)) i++;
            out += ch;
          }
          break;
      }

      attr = data;
    }

    if (attr !== this.defAttr) {
      out += '</span>';
    }

    this.children[y].innerHTML = out;
  }

  if (parent) parent.appendChild(this.element);
};

Terminal.prototype._cursorBlink = function() {
  if (Terminal.focus !== this) return;
  this.cursorState ^= 1;
  this.refresh(this.y, this.y);
};

Terminal.prototype.showCursor = function() {
  if (!this.cursorState) {
    this.cursorState = 1;
    this.refresh(this.y, this.y);
  } else {}
};

Terminal.prototype.startBlink = function() {
  if (!this.cursorBlink) return;
  var self = this;
  this._blinker = function() {
    self._cursorBlink();
  };
  this._blink = setInterval(this._blinker, 500);
};

Terminal.prototype.refreshBlink = function() {
  if (!this.cursorBlink || !this._blink) return;
  clearInterval(this._blink);
  this._blink = setInterval(this._blinker, 500);
};

Terminal.prototype.scroll = function() {
  var row;

  if (++this.ybase === this.scrollback) {
    this.ybase = this.ybase / 2 | 0;
    this.lines = this.lines.slice(-(this.ybase + this.rows) + 1);
  }

  this.ydisp = this.ybase;

  // last line
  row = this.ybase + this.rows - 1;

  // subtract the bottom scroll region
  row -= this.rows - 1 - this.scrollBottom;

  if (row === this.lines.length) {
    this.lines.push(this.blankLine());
  } else {
    // add our new line
    this.lines.splice(row, 0, this.blankLine());
  }

  if (this.scrollTop !== 0) {
    if (this.ybase !== 0) {
      this.ybase--;
      this.ydisp = this.ybase;
    }
    this.lines.splice(this.ybase + this.scrollTop, 1);
  }

  // this.maxRange();
  this.updateRange(this.scrollTop);
  this.updateRange(this.scrollBottom);
};

Terminal.prototype.scrollDisp = function(disp) {
  this.ydisp += disp;

  if (this.ydisp > this.ybase) {
    this.ydisp = this.ybase;
  } else if (this.ydisp < 0) {
    this.ydisp = 0;
  }

  this.refresh(0, this.rows - 1);
};

Terminal.prototype.write = function(data) {
  var l = data.length
    , i = 0
    , j
    , cs
    , ch;

  this.refreshStart = this.y;
  this.refreshEnd = this.y;

  if (this.ybase !== this.ydisp) {
    this.ydisp = this.ybase;
    this.maxRange();
  }

  // this.log(JSON.stringify(data.replace(/\x1b/g, '^[')));

  for (; i < l; i++, this.lch = ch) {
    ch = data[i];
    switch (this.state) {
      case normal:
        switch (ch) {
          case '\x07':
            this.bell();
            break;

          // '\n', '\v', '\f'
          case '\n':
          case '\x0b':
          case '\x0c':
            if (this.convertEol) {
              this.x = 0;
            }
            
            this.y++;
            if (this.y > this.scrollBottom) {
              this.y--;
              this.scroll();
            }
            break;

          // '\r'
          case '\r':
            this.x = 0;
            break;

          // '\b'
          case '\x08':
            if (this.x > 0) {
              this.x--;
            }
            break;

          // '\t'
          case '\t':
            this.x = this.nextStop();
            break;

          // shift out
          case '\x0e':
            this.setgLevel(1);
            break;

          // shift in
          case '\x0f':
            this.setgLevel(0);
            break;

          // '\e'
          case '\x1b':
            this.state = escaped;
            break;

          default:
            // ' '
            if (ch >= ' ') {
              if (this.charset && this.charset[ch]) {
                ch = this.charset[ch];
              }

              if (this.x >= this.cols) {
                this.x = 0;
                this.y++;
                if (this.y > this.scrollBottom) {
                  this.y--;
                  this.scroll();
                }
              }

              this.lines[this.y + this.ybase][this.x] = [this.curAttr, ch];
              this.x++;
              this.updateRange(this.y);

              if (isWide(ch)) {
                j = this.y + this.ybase;
                if (this.cols < 2 || this.x >= this.cols) {
                  this.lines[j][this.x - 1] = [this.curAttr, ' '];
                  break;
                }
                this.lines[j][this.x] = [this.curAttr, ' '];
                this.x++;
              }
            }
            break;
        }
        break;
      case escaped:
        switch (ch) {
          // ESC [ Control Sequence Introducer ( CSI is 0x9b).
          case '[':
            this.params = [];
            this.currentParam = 0;
            this.state = csi;
            break;

          // ESC ] Operating System Command ( OSC is 0x9d).
          case ']':
            this.params = [];
            this.currentParam = 0;
            this.state = osc;
            break;

          // ESC P Device Control String ( DCS is 0x90).
          case 'P':
            this.params = [];
            this.prefix = '';
            this.currentParam = '';
            this.state = dcs;
            break;

          // ESC _ Application Program Command ( APC is 0x9f).
          case '_':
            this.state = ignore;
            break;

          // ESC ^ Privacy Message ( PM is 0x9e).
          case '^':
            this.state = ignore;
            break;

          // ESC c Full Reset (RIS).
          case 'c':
            this.reset();
            break;

          // ESC E Next Line ( NEL is 0x85).
          // ESC D Index ( IND is 0x84).
          case 'E':
            this.x = 0;
            ;
          case 'D':
            this.index();
            break;

          // ESC M Reverse Index ( RI is 0x8d).
          case 'M':
            this.reverseIndex();
            break;

          // ESC % Select default/utf-8 character set.
          // @ = default, G = utf-8
          case '%':
            //this.charset = null;
            this.setgLevel(0);
            this.setgCharset(0, Terminal.charsets.US);
            this.state = normal;
            i++;
            break;

          // ESC (,),*,+,-,. Designate G0-G2 Character Set.
          case '(': // <-- this seems to get all the attention
          case ')':
          case '*':
          case '+':
          case '-':
          case '.':
            switch (ch) {
              case '(':
                this.gcharset = 0;
                break;
              case ')':
                this.gcharset = 1;
                break;
              case '*':
                this.gcharset = 2;
                break;
              case '+':
                this.gcharset = 3;
                break;
              case '-':
                this.gcharset = 1;
                break;
              case '.':
                this.gcharset = 2;
                break;
            }
            this.state = charset;
            break;

          case '/':
            this.gcharset = 3;
            this.state = charset;
            i--;
            break;

          
          case 'N':
            break;
          
          case 'O':
            break;
          // ESC n
          // Invoke the G2 Character Set as GL (LS2).
          case 'n':
            this.setgLevel(2);
            break;
          // ESC o
          // Invoke the G3 Character Set as GL (LS3).
          case 'o':
            this.setgLevel(3);
            break;
          // ESC |
          // Invoke the G3 Character Set as GR (LS3R).
          case '|':
            this.setgLevel(3);
            break;
          // ESC }
          // Invoke the G2 Character Set as GR (LS2R).
          case '}':
            this.setgLevel(2);
            break;
          // ESC ~
          // Invoke the G1 Character Set as GR (LS1R).
          case '~':
            this.setgLevel(1);
            break;

          // ESC 7 Save Cursor (DECSC).
          case '7':
            this.saveCursor();
            this.state = normal;
            break;

          // ESC 8 Restore Cursor (DECRC).
          case '8':
            this.restoreCursor();
            this.state = normal;
            break;

          // ESC # 3 DEC line height/width
          case '#':
            this.state = normal;
            i++;
            break;

          // ESC H Tab Set (HTS is 0x88).
          case 'H':
            this.tabSet();
            break;

          // ESC = Application Keypad (DECPAM).
          case '=':
            this.log('Serial port requested application keypad.');
            this.applicationKeypad = true;
            this.state = normal;
            break;

          // ESC > Normal Keypad (DECPNM).
          case '>':
            this.log('Switching back to normal keypad.');
            this.applicationKeypad = false;
            this.state = normal;
            break;

          default:
            this.state = normal;
            this.error('Unknown ESC control: %s.', ch);
            break;
        }
        break;

      case charset:
        switch (ch) {
          case '0': // DEC Special Character and Line Drawing Set.
            cs = Terminal.charsets.SCLD;
            break;
          case 'A': // UK
            cs = Terminal.charsets.UK;
            break;
          case 'B': // United States (USASCII).
            cs = Terminal.charsets.US;
            break;
          case '4': // Dutch
            cs = Terminal.charsets.Dutch;
            break;
          case 'C': // Finnish
          case '5':
            cs = Terminal.charsets.Finnish;
            break;
          case 'R': // French
            cs = Terminal.charsets.French;
            break;
          case 'Q': // FrenchCanadian
            cs = Terminal.charsets.FrenchCanadian;
            break;
          case 'K': // German
            cs = Terminal.charsets.German;
            break;
          case 'Y': // Italian
            cs = Terminal.charsets.Italian;
            break;
          case 'E': // NorwegianDanish
          case '6':
            cs = Terminal.charsets.NorwegianDanish;
            break;
          case 'Z': // Spanish
            cs = Terminal.charsets.Spanish;
            break;
          case 'H': // Swedish
          case '7':
            cs = Terminal.charsets.Swedish;
            break;
          case '=': // Swiss
            cs = Terminal.charsets.Swiss;
            break;
          case '/': // ISOLatin (actually /A)
            cs = Terminal.charsets.ISOLatin;
            i++;
            break;
          default: // Default
            cs = Terminal.charsets.US;
            break;
        }
        this.setgCharset(this.gcharset, cs);
        this.gcharset = null;
        this.state = normal;
        break;

      case osc:
        // OSC Ps ; Pt ST
        // OSC Ps ; Pt BEL
        //   Set Text Parameters.
        if ((this.lch === '\x1b' && ch === '\\') || ch === '\x07') {
          if (this.lch === '\x1b') {
            if (typeof this.currentParam === 'string') {
              this.currentParam = this.currentParam.slice(0, -1);
            } else if (typeof this.currentParam == 'number') {
              this.currentParam = (this.currentParam - ('\x1b'.charCodeAt(0) - 48)) / 10;
            }
          }

          this.params.push(this.currentParam);

          switch (this.params[0]) {
            case 0:
            case 1:
            case 2:
              if (this.params[1]) {
                this.title = this.params[1];
                this.handleTitle(this.title);
              }
              break;
            case 3:
              // set X property
              break;
            case 4:
            case 5:
              // change dynamic colors
              break;
            case 10:
            case 11:
            case 12:
            case 13:
            case 14:
            case 15:
            case 16:
            case 17:
            case 18:
            case 19:
              // change dynamic ui colors
              break;
            case 46:
              // change log file
              break;
            case 50:
              // dynamic font
              break;
            case 51:
              // emacs shell
              break;
            case 52:
              // manipulate selection data
              break;
            case 104:
            case 105:
            case 110:
            case 111:
            case 112:
            case 113:
            case 114:
            case 115:
            case 116:
            case 117:
            case 118:
              // reset colors
              break;
          }

          this.params = [];
          this.currentParam = 0;
          this.state = normal;
        } else {
          if (!this.params.length) {
            if (ch >= '0' && ch <= '9') {
              this.currentParam =
                this.currentParam * 10 + ch.charCodeAt(0) - 48;
            } else if (ch === ';') {
              this.params.push(this.currentParam);
              this.currentParam = '';
            }
          } else {
            this.currentParam += ch;
          }
        }
        break;

      case csi:
        // '?', '>', '!'
        if (ch === '?' || ch === '>' || ch === '!') {
          this.prefix = ch;
          break;
        }

        // 0 - 9
        if (ch >= '0' && ch <= '9') {
          this.currentParam = this.currentParam * 10 + ch.charCodeAt(0) - 48;
          break;
        }

        // '$', '"', ' ', '\''
        if (ch === '$' || ch === '"' || ch === ' ' || ch === '\'') {
          this.postfix = ch;
          break;
        }

        this.params.push(this.currentParam);
        this.currentParam = 0;

        // ';'
        if (ch === ';') break;

        this.state = normal;

        switch (ch) {
          // CSI Ps A
          // Cursor Up Ps Times (default = 1) (CUU).
          case 'A':
            this.cursorUp(this.params);
            break;

          // CSI Ps B
          // Cursor Down Ps Times (default = 1) (CUD).
          case 'B':
            this.cursorDown(this.params);
            break;

          // CSI Ps C
          // Cursor Forward Ps Times (default = 1) (CUF).
          case 'C':
            this.cursorForward(this.params);
            break;

          // CSI Ps D
          // Cursor Backward Ps Times (default = 1) (CUB).
          case 'D':
            this.cursorBackward(this.params);
            break;

          // CSI Ps ; Ps H
          // Cursor Position [row;column] (default = [1,1]) (CUP).
          case 'H':
            this.cursorPos(this.params);
            break;

          // CSI Ps J  Erase in Display (ED).
          case 'J':
            this.eraseInDisplay(this.params);
            break;

          // CSI Ps K  Erase in Line (EL).
          case 'K':
            this.eraseInLine(this.params);
            break;

          // CSI Pm m  Character Attributes (SGR).
          case 'm':
            if (!this.prefix) {
              this.charAttributes(this.params);
            }
            break;

          // CSI Ps n  Device Status Report (DSR).
          case 'n':
            if (!this.prefix) {
              this.deviceStatus(this.params);
            }
            break;

          /**
           * Additions
           */

          // CSI Ps @
          // Insert Ps (Blank) Character(s) (default = 1) (ICH).
          case '@':
            this.insertChars(this.params);
            break;

          // CSI Ps E
          // Cursor Next Line Ps Times (default = 1) (CNL).
          case 'E':
            this.cursorNextLine(this.params);
            break;

          // CSI Ps F
          // Cursor Preceding Line Ps Times (default = 1) (CNL).
          case 'F':
            this.cursorPrecedingLine(this.params);
            break;

          // CSI Ps G
          // Cursor Character Absolute  [column] (default = [row,1]) (CHA).
          case 'G':
            this.cursorCharAbsolute(this.params);
            break;

          // CSI Ps L
          // Insert Ps Line(s) (default = 1) (IL).
          case 'L':
            this.insertLines(this.params);
            break;

          // CSI Ps M
          // Delete Ps Line(s) (default = 1) (DL).
          case 'M':
            this.deleteLines(this.params);
            break;

          // CSI Ps P
          // Delete Ps Character(s) (default = 1) (DCH).
          case 'P':
            this.deleteChars(this.params);
            break;

          // CSI Ps X
          // Erase Ps Character(s) (default = 1) (ECH).
          case 'X':
            this.eraseChars(this.params);
            break;

          // CSI Pm `  Character Position Absolute
          //   [column] (default = [row,1]) (HPA).
          case '`':
            this.charPosAbsolute(this.params);
            break;

          // 141 61 a * HPR -
          // Horizontal Position Relative
          case 'a':
            this.HPositionRelative(this.params);
            break;

          case 'c':
            this.sendDeviceAttributes(this.params);
            break;

          // CSI Pm d
          // Line Position Absolute  [row] (default = [1,column]) (VPA).
          case 'd':
            this.linePosAbsolute(this.params);
            break;

          // 145 65 e * VPR - Vertical Position Relative
          case 'e':
            this.VPositionRelative(this.params);
            break;

          // CSI Ps ; Ps f
          //   Horizontal and Vertical Position [row;column] (default =
          //   [1,1]) (HVP).
          case 'f':
            this.HVPosition(this.params);
            break;

          // CSI Pm h  Set Mode (SM).
          // CSI ? Pm h - mouse escape codes, cursor escape codes
          case 'h':
            this.setMode(this.params);
            break;

          // CSI Pm l  Reset Mode (RM).
          // CSI ? Pm l
          case 'l':
            this.resetMode(this.params);
            break;

          case 'r':
            this.setScrollRegion(this.params);
            break;

          // CSI s
          //   Save cursor (ANSI.SYS).
          case 's':
            this.saveCursor(this.params);
            break;

          // CSI u
          //   Restore cursor (ANSI.SYS).
          case 'u':
            this.restoreCursor(this.params);
            break;

          /**
           * Lesser Used
           */

          // CSI Ps I
          // Cursor Forward Tabulation Ps tab stops (default = 1) (CHT).
          case 'I':
            this.cursorForwardTab(this.params);
            break;

          // CSI Ps S  Scroll up Ps lines (default = 1) (SU).
          case 'S':
            this.scrollUp(this.params);
            break;
          
          case 'T':
            
            if (this.params.length < 2 && !this.prefix) {
              this.scrollDown(this.params);
            }
            break;

          // CSI Ps Z
          // Cursor Backward Tabulation Ps tab stops (default = 1) (CBT).
          case 'Z':
            this.cursorBackwardTab(this.params);
            break;

          // CSI Ps b  Repeat the preceding graphic character Ps times (REP).
          case 'b':
            this.repeatPrecedingCharacter(this.params);
            break;

          // CSI Ps g  Tab Clear (TBC).
          case 'g':
            this.tabClear(this.params);
            break;

          case 'p':
            switch (this.prefix) {
              case '!':
                this.softReset(this.params);
                break;
            }
            break;

          default:
            this.error('Unknown CSI code: %s.', ch);
            break;
        }

        this.prefix = '';
        this.postfix = '';
        break;

      case dcs:
        if ((this.lch === '\x1b' && ch === '\\') || ch === '\x07') {
          // Workarounds:
          if (this.prefix === 'tmux;\x1b') {
            
            if (ch === '\x07') {
              this.currentParam += ch;
              continue;
            }
          }

          if (this.lch === '\x1b') {
            if (typeof this.currentParam === 'string') {
              this.currentParam = this.currentParam.slice(0, -1);
            } else if (typeof this.currentParam == 'number') {
              this.currentParam = (this.currentParam - ('\x1b'.charCodeAt(0) - 48)) / 10;
            }
          }

          this.params.push(this.currentParam);

          var pt = this.params[this.params.length - 1];

          switch (this.prefix) {
            // User-Defined Keys (DECUDK).
            // DCS Ps; Ps| Pt ST
            case UDK:
              this.emit('udk', {
                clearAll: this.params[0] === 0,
                eraseBelow: this.params[0] === 1,
                lockKeys: this.params[1] === 0,
                dontLockKeys: this.params[1] === 1,
                keyList: (this.params[2] + '').split(';').map(function(part) {
                  part = part.split('/');
                  return {
                    keyCode: part[0],
                    hexKeyValue: part[1]
                  };
                })
              });
              break;

            // Request Status String (DECRQSS).
            // DCS $ q Pt ST
            // test: echo -e '\eP$q"p\e\\'
            case '$q':
              var valid = 0;

              switch (pt) {
                // DECSCA
                // CSI Ps " q
                case '"q':
                  pt = '0"q';
                  valid = 1;
                  break;

                // DECSCL
                // CSI Ps ; Ps " p
                case '"p':
                  pt = '61;0"p';
                  valid = 1;
                  break;

                // DECSTBM
                // CSI Ps ; Ps r
                case 'r':
                  pt = ''
                    + (this.scrollTop + 1)
                    + ';'
                    + (this.scrollBottom + 1)
                    + 'r';
                  valid = 1;
                  break;

                // SGR
                // CSI Pm m
                case 'm':
                  // TODO: Parse this.curAttr here.
                  // pt = '0m';
                  // valid = 1;
                  valid = 0; // Not implemented.
                  break;

                default:
                  this.error('Unknown DCS Pt: %s.', pt);
                  valid = 0; // unimplemented
                  break;
              }

              this.send('\x1bP' + valid + '$r' + pt + '\x1b\\');
              break;

            // Set Termcap/Terminfo Data (xterm, experimental).
            // DCS + p Pt ST
            case '+p':
              this.emit('set terminfo', {
                name: this.params[0]
              });
              break;

            case '+q':
              var valid = false;
              this.send('\x1bP' + +valid + '+r' + pt + '\x1b\\');
              break;

            // Implement tmux sequence forwarding is
            // someone uses term.js for a multiplexer.
            // DCS tmux; ESC Pt ST
            case 'tmux;\x1b':
              this.emit('passthrough', pt);
              break;

            default:
              this.error('Unknown DCS prefix: %s.', pt);
              break;
          }

          this.currentParam = 0;
          this.prefix = '';
          this.state = normal;
        } else {
          this.currentParam += ch;
          if (!this.prefix) {
            if (/^\d*;\d*\|/.test(this.currentParam)) {
              this.prefix = UDK;
              this.params = this.currentParam.split(/[;|]/).map(function(n) {
                if (!n.length) return 0;
                return +n;
              }).slice(0, -1);
              this.currentParam = '';
            } else if (/^[$+][a-zA-Z]/.test(this.currentParam)
                || /^\w+;\x1b/.test(this.currentParam)) {
              this.prefix = this.currentParam;
              this.currentParam = '';
            }
          }
        }
        break;

      case ignore:
        // For PM and APC.
        if ((this.lch === '\x1b' && ch === '\\') || ch === '\x07') {
          this.state = normal;
        }
        break;
    }
  }

  this.updateRange(this.y);
  this.refresh(this.refreshStart, this.refreshEnd);

  return true;
};

Terminal.prototype.writeln = function(data) {
  return this.write(data + '\r\n');
};

Terminal.prototype.end = function(data) {
  var ret = true;
  if (data) {
    ret = this.write(data);
  }
  this.destroySoon();
  return ret;
};

Terminal.prototype.resume = function() {
  ;
};

Terminal.prototype.pause = function() {
  ;
};

// Key Resources:
// https://developer.mozilla.org/en-US/docs/DOM/KeyboardEvent
Terminal.prototype.keyDown = function(ev) {
  var self = this
    , key;

  switch (ev.keyCode) {
    // backspace
    case 8:
      if (ev.altKey) {
        key = '\x17';
        break;
      }
      if (ev.shiftKey) {
        key = '\x08'; // ^H
        break;
      }
      key = '\x7f'; // ^?
      break;
    // tab
    case 9:
      if (ev.shiftKey) {
        key = '\x1b[Z';
        break;
      }
      key = '\t';
      break;
    // return/enter
    case 13:
      key = '\r';
      break;
    // escape
    case 27:
      key = '\x1b';
      break;
    // space
    case 32:
      key = '\x20';
      break;
    // left-arrow
    case 37:
      if (this.applicationCursor) {
        key = '\x1bOD'; // SS3 as ^[O for 7-bit
        //key = '\x8fD'; // SS3 as 0x8f for 8-bit
        break;
      }
      if (ev.ctrlKey) {
        key = '\x1b[5D';
        break;
      }
      key = '\x1b[D';
      break;
    // right-arrow
    case 39:
      if (this.applicationCursor) {
        key = '\x1bOC';
        break;
      }
      if (ev.ctrlKey) {
        key = '\x1b[5C';
        break;
      }
      key = '\x1b[C';
      break;
    // up-arrow
    case 38:
      if (this.applicationCursor) {
        key = '\x1bOA';
        break;
      }
      if (ev.ctrlKey) {
        this.scrollDisp(-1);
        return cancel(ev);
      } else {
        key = '\x1b[A';
      }
      break;
    // down-arrow
    case 40:
      if (this.applicationCursor) {
        key = '\x1bOB';
        break;
      }
      if (ev.ctrlKey) {
        this.scrollDisp(1);
        return cancel(ev);
      } else {
        key = '\x1b[B';
      }
      break;
    // delete
    case 46:
      key = '\x1b[3~';
      break;
    // insert
    case 45:
      key = '\x1b[2~';
      break;
    // home
    case 36:
      if (this.applicationKeypad) {
        key = '\x1bOH';
        break;
      }
      key = '\x1bOH';
      break;
    // end
    case 35:
      if (this.applicationKeypad) {
        key = '\x1bOF';
        break;
      }
      key = '\x1bOF';
      break;
    // page up
    case 33:
      if (ev.shiftKey) {
        this.scrollDisp(-(this.rows - 1));
        return cancel(ev);
      } else {
        key = '\x1b[5~';
      }
      break;
    // page down
    case 34:
      if (ev.shiftKey) {
        this.scrollDisp(this.rows - 1);
        return cancel(ev);
      } else {
        key = '\x1b[6~';
      }
      break;
    // F1
    case 112:
      key = '\x1bOP';
      break;
    // F2
    case 113:
      key = '\x1bOQ';
      break;
    // F3
    case 114:
      key = '\x1bOR';
      break;
    // F4
    case 115:
      key = '\x1bOS';
      break;
    // F5
    case 116:
      key = '\x1b[15~';
      break;
    // F6
    case 117:
      key = '\x1b[17~';
      break;
    // F7
    case 118:
      key = '\x1b[18~';
      break;
    // F8
    case 119:
      key = '\x1b[19~';
      break;
    // F9
    case 120:
      key = '\x1b[20~';
      break;
    // F10
    case 121:
      key = '\x1b[21~';
      break;
    // F11
    case 122:
      key = '\x1b[23~';
      break;
    // F12
    case 123:
      key = '\x1b[24~';
      break;
    default:
      // a-z and space
      if (ev.ctrlKey) {
        if (ev.keyCode >= 65 && ev.keyCode <= 90) {
          // Ctrl-A
          if (this.screenKeys) {
            if (!this.prefixMode && !this.selectMode && ev.keyCode === 65) {
              this.enterPrefix();
              return cancel(ev);
            }
          }
          // Ctrl-V
          if (this.prefixMode && ev.keyCode === 86) {
            this.leavePrefix();
            // Workaround for Firefox to let it actually fire Paste event
            var term = Terminal.focus;
            term.element.contentEditable = 'true';
            return;
          }
          // Ctrl-C
          if ((this.prefixMode || this.selectMode) && ev.keyCode === 67) {
            if (this.visualMode) {
              setTimeout(function() {
                self.leaveVisual();
              }, 1);
            }
            return;
          }
          key = String.fromCharCode(ev.keyCode - 64);
        } else if (ev.keyCode === 32) {
          // NUL
          key = String.fromCharCode(0);
        } else if (ev.keyCode >= 51 && ev.keyCode <= 55) {
          // escape, file sep, group sep, record sep, unit sep
          key = String.fromCharCode(ev.keyCode - 51 + 27);
        } else if (ev.keyCode === 56) {
          // delete
          key = String.fromCharCode(127);
        } else if (ev.keyCode === 219) {
          // ^[ - escape
          key = String.fromCharCode(27);
        } else if (ev.keyCode === 221) {
          // ^] - group sep
          key = String.fromCharCode(29);
        }
      } else if (ev.altKey) {
        if (ev.keyCode >= 65 && ev.keyCode <= 90) {
          key = '\x1b' + String.fromCharCode(ev.keyCode + 32);
        } else if (ev.keyCode === 192) {
          key = '\x1b`';
        } else if (ev.keyCode >= 48 && ev.keyCode <= 57) {
          key = '\x1b' + (ev.keyCode - 48);
        }
      }
      break;
  }

  if (!key) return true;

  if (this.prefixMode) {
    this.leavePrefix();
    return cancel(ev);
  }

  if (this.selectMode) {
    this.keySelect(ev, key);
    return cancel(ev);
  }

  this.emit('keydown', ev);
  this.emit('key', key, ev);

  this.showCursor();
  this.handler(key);

  return cancel(ev);
};

Terminal.prototype.setgLevel = function(g) {
  this.glevel = g;
  this.charset = this.charsets[g];
};

Terminal.prototype.setgCharset = function(g, charset) {
  this.charsets[g] = charset;
  if (this.glevel === g) {
    this.charset = charset;
  }
};

Terminal.prototype.keyPress = function(ev) {
  var key;

  cancel(ev);

  if (ev.charCode) {
    key = ev.charCode;
  } else if (ev.which == null) {
    key = ev.keyCode;
  } else if (ev.which !== 0 && ev.charCode !== 0) {
    key = ev.which;
  } else {
    return false;
  }

  if (!key || ev.ctrlKey || ev.altKey || ev.metaKey) return false;

  key = String.fromCharCode(key);

  if (this.prefixMode) {
    this.leavePrefix();
    this.keyPrefix(ev, key);
    return false;
  }

  if (this.selectMode) {
    this.keySelect(ev, key);
    return false;
  }

  this.emit('keypress', key, ev);
  this.emit('key', key, ev);

  this.showCursor();
  this.handler(key);

  return false;
};

Terminal.prototype.send = function(data) {
  var self = this;

  if (!this.queue) {
    setTimeout(function() {
      self.handler(self.queue);
      self.queue = '';
    }, 1);
  }

  this.queue += data;
};

Terminal.prototype.bell = function() {
  this.emit('bell');
  if (!this.visualBell) return;
  var self = this;
  this.element.style.borderColor = 'white';
  setTimeout(function() {
    self.element.style.borderColor = '';
  }, 10);
  if (this.popOnBell) this.focus();
};

Terminal.prototype.log = function() {
  if (!this.debug) return;
  if (!this.context.console || !this.context.console.log) return;
  var args = Array.prototype.slice.call(arguments);
  this.context.console.log.apply(this.context.console, args);
};

Terminal.prototype.error = function() {
  if (!this.debug) return;
  if (!this.context.console || !this.context.console.error) return;
  var args = Array.prototype.slice.call(arguments);
  this.context.console.error.apply(this.context.console, args);
};

Terminal.prototype.resize = function(x, y) {
  var line
    , el
    , i
    , j
    , ch;

  if (x < 1) x = 1;
  if (y < 1) y = 1;

  // resize cols
  j = this.cols;
  if (j < x) {
    ch = [this.defAttr, ' ']; // does xterm use the default attr?
    i = this.lines.length;
    while (i--) {
      while (this.lines[i].length < x) {
        this.lines[i].push(ch);
      }
    }
  } else if (j > x) {
    i = this.lines.length;
    while (i--) {
      while (this.lines[i].length > x) {
        this.lines[i].pop();
      }
    }
  }
  this.setupStops(j);
  this.cols = x;
  this.columns = x;

  // resize rows
  j = this.rows;
  if (j < y) {
    el = this.element;
    while (j++ < y) {
      if (this.lines.length < y + this.ybase) {
        this.lines.push(this.blankLine());
      }
      if (this.children.length < y) {
        line = this.document.createElement('div');
        el.appendChild(line);
        this.children.push(line);
      }
    }
  } else if (j > y) {
    while (j-- > y) {
      if (this.lines.length > y + this.ybase) {
        this.lines.pop();
      }
      if (this.children.length > y) {
        el = this.children.pop();
        if (!el) continue;
        el.parentNode.removeChild(el);
      }
    }
  }
  this.rows = y;

  // make sure the cursor stays on screen
  if (this.y >= y) this.y = y - 1;
  if (this.x >= x) this.x = x - 1;

  this.scrollTop = 0;
  this.scrollBottom = y - 1;

  this.refresh(0, this.rows - 1);

  this.normal = null;

  // Act as though we are a node TTY stream:
  this.emit('resize');
};

Terminal.prototype.updateRange = function(y) {
  if (y < this.refreshStart) this.refreshStart = y;
  if (y > this.refreshEnd) this.refreshEnd = y;
  
};

Terminal.prototype.maxRange = function() {
  this.refreshStart = 0;
  this.refreshEnd = this.rows - 1;
};

Terminal.prototype.setupStops = function(i) {
  if (i != null) {
    if (!this.tabs[i]) {
      i = this.prevStop(i);
    }
  } else {
    this.tabs = {};
    i = 0;
  }

  for (; i < this.cols; i += 8) {
    this.tabs[i] = true;
  }
};

Terminal.prototype.prevStop = function(x) {
  if (x == null) x = this.x;
  while (!this.tabs[--x] && x > 0);
  return x >= this.cols
    ? this.cols - 1
    : x < 0 ? 0 : x;
};

Terminal.prototype.nextStop = function(x) {
  if (x == null) x = this.x;
  while (!this.tabs[++x] && x < this.cols);
  return x >= this.cols
    ? this.cols - 1
    : x < 0 ? 0 : x;
};

// back_color_erase feature for xterm.
Terminal.prototype.eraseAttr = function() {
  // if (this.is('screen')) return this.defAttr;
  return (this.defAttr & ~0x1ff) | (this.curAttr & 0x1ff);
};

Terminal.prototype.eraseRight = function(x, y) {
  var line = this.lines[this.ybase + y]
    , ch = [this.eraseAttr(), ' ']; // xterm


  for (; x < this.cols; x++) {
    line[x] = ch;
  }

  this.updateRange(y);
};

Terminal.prototype.eraseLeft = function(x, y) {
  var line = this.lines[this.ybase + y]
    , ch = [this.eraseAttr(), ' ']; // xterm

  x++;
  while (x--) line[x] = ch;

  this.updateRange(y);
};

Terminal.prototype.eraseLine = function(y) {
  this.eraseRight(0, y);
};

Terminal.prototype.blankLine = function(cur) {
  var attr = cur
    ? this.eraseAttr()
    : this.defAttr;

  var ch = [attr, ' ']
    , line = []
    , i = 0;

  for (; i < this.cols; i++) {
    line[i] = ch;
  }

  return line;
};

Terminal.prototype.ch = function(cur) {
  return cur
    ? [this.eraseAttr(), ' ']
    : [this.defAttr, ' '];
};

Terminal.prototype.is = function(term) {
  var name = this.termName;
  return (name + '').indexOf(term) === 0;
};

Terminal.prototype.handler = function(data) {
  this.emit('data', data);
};

Terminal.prototype.handleTitle = function(title) {
  this.emit('title', title);
};

/**
 * ESC
 */

// ESC D Index (IND is 0x84).
Terminal.prototype.index = function() {
  this.y++;
  if (this.y > this.scrollBottom) {
    this.y--;
    this.scroll();
  }
  this.state = normal;
};

// ESC M Reverse Index (RI is 0x8d).
Terminal.prototype.reverseIndex = function() {
  var j;
  this.y--;
  if (this.y < this.scrollTop) {
    this.y++;
    this.lines.splice(this.y + this.ybase, 0, this.blankLine(true));
    j = this.rows - 1 - this.scrollBottom;
    this.lines.splice(this.rows - 1 + this.ybase - j + 1, 1);
    // this.maxRange();
    this.updateRange(this.scrollTop);
    this.updateRange(this.scrollBottom);
  }
  this.state = normal;
};

// ESC c Full Reset (RIS).
Terminal.prototype.reset = function() {
  this.options.rows = this.rows;
  this.options.cols = this.cols;
  Terminal.call(this, this.options);
  this.refresh(0, this.rows - 1);
};

// ESC H Tab Set (HTS is 0x88).
Terminal.prototype.tabSet = function() {
  this.tabs[this.x] = true;
  this.state = normal;
};

/**
 * CSI
 */

// CSI Ps A
// Cursor Up Ps Times (default = 1) (CUU).
Terminal.prototype.cursorUp = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.y -= param;
  if (this.y < 0) this.y = 0;
};

// CSI Ps B
// Cursor Down Ps Times (default = 1) (CUD).
Terminal.prototype.cursorDown = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.y += param;
  if (this.y >= this.rows) {
    this.y = this.rows - 1;
  }
};

// CSI Ps C
// Cursor Forward Ps Times (default = 1) (CUF).
Terminal.prototype.cursorForward = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.x += param;
  if (this.x >= this.cols) {
    this.x = this.cols - 1;
  }
};

// CSI Ps D
// Cursor Backward Ps Times (default = 1) (CUB).
Terminal.prototype.cursorBackward = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.x -= param;
  if (this.x < 0) this.x = 0;
};

// CSI Ps ; Ps H
// Cursor Position [row;column] (default = [1,1]) (CUP).
Terminal.prototype.cursorPos = function(params) {
  var row, col;

  row = params[0] - 1;

  if (params.length >= 2) {
    col = params[1] - 1;
  } else {
    col = 0;
  }

  if (row < 0) {
    row = 0;
  } else if (row >= this.rows) {
    row = this.rows - 1;
  }

  if (col < 0) {
    col = 0;
  } else if (col >= this.cols) {
    col = this.cols - 1;
  }

  this.x = col;
  this.y = row;
};

Terminal.prototype.eraseInDisplay = function(params) {
  var j;
  switch (params[0]) {
    case 0:
      this.eraseRight(this.x, this.y);
      j = this.y + 1;
      for (; j < this.rows; j++) {
        this.eraseLine(j);
      }
      break;
    case 1:
      this.eraseLeft(this.x, this.y);
      j = this.y;
      while (j--) {
        this.eraseLine(j);
      }
      break;
    case 2:
      j = this.rows;
      while (j--) this.eraseLine(j);
      break;
    case 3:
      ; // no saved lines
      break;
  }
};

Terminal.prototype.eraseInLine = function(params) {
  switch (params[0]) {
    case 0:
      this.eraseRight(this.x, this.y);
      break;
    case 1:
      this.eraseLeft(this.x, this.y);
      break;
    case 2:
      this.eraseLine(this.y);
      break;
  }
};

Terminal.prototype.charAttributes = function(params) {
  // Optimize a single SGR0.
  if (params.length === 1 && params[0] === 0) {
    this.curAttr = this.defAttr;
    return;
  }

  var l = params.length
    , i = 0
    , flags = this.curAttr >> 18
    , fg = (this.curAttr >> 9) & 0x1ff
    , bg = this.curAttr & 0x1ff
    , p;

  for (; i < l; i++) {
    p = params[i];
    if (p >= 30 && p <= 37) {
      // fg color 8
      fg = p - 30;
    } else if (p >= 40 && p <= 47) {
      // bg color 8
      bg = p - 40;
    } else if (p >= 90 && p <= 97) {
      // fg color 16
      p += 8;
      fg = p - 90;
    } else if (p >= 100 && p <= 107) {
      // bg color 16
      p += 8;
      bg = p - 100;
    } else if (p === 0) {
      // default
      flags = this.defAttr >> 18;
      fg = (this.defAttr >> 9) & 0x1ff;
      bg = this.defAttr & 0x1ff;
      // flags = 0;
      // fg = 0x1ff;
      // bg = 0x1ff;
    } else if (p === 1) {
      // bold text
      flags |= 1;
    } else if (p === 4) {
      // underlined text
      flags |= 2;
    } else if (p === 5) {
      // blink
      flags |= 4;
    } else if (p === 7) {
      // inverse and positive
      // test with: echo -e '\e[31m\e[42mhello\e[7mworld\e[27mhi\e[m'
      flags |= 8;
    } else if (p === 8) {
      // invisible
      flags |= 16;
    } else if (p === 22) {
      // not bold
      flags &= ~1;
    } else if (p === 24) {
      // not underlined
      flags &= ~2;
    } else if (p === 25) {
      // not blink
      flags &= ~4;
    } else if (p === 27) {
      // not inverse
      flags &= ~8;
    } else if (p === 28) {
      // not invisible
      flags &= ~16;
    } else if (p === 39) {
      // reset fg
      fg = (this.defAttr >> 9) & 0x1ff;
    } else if (p === 49) {
      // reset bg
      bg = this.defAttr & 0x1ff;
    } else if (p === 38) {
      // fg color 256
      if (params[i + 1] === 2) {
        i += 2;
        fg = matchColor(
          params[i] & 0xff,
          params[i + 1] & 0xff,
          params[i + 2] & 0xff);
        if (fg === -1) fg = 0x1ff;
        i += 2;
      } else if (params[i + 1] === 5) {
        i += 2;
        p = params[i] & 0xff;
        fg = p;
      }
    } else if (p === 48) {
      // bg color 256
      if (params[i + 1] === 2) {
        i += 2;
        bg = matchColor(
          params[i] & 0xff,
          params[i + 1] & 0xff,
          params[i + 2] & 0xff);
        if (bg === -1) bg = 0x1ff;
        i += 2;
      } else if (params[i + 1] === 5) {
        i += 2;
        p = params[i] & 0xff;
        bg = p;
      }
    } else if (p === 100) {
      // reset fg/bg
      fg = (this.defAttr >> 9) & 0x1ff;
      bg = this.defAttr & 0x1ff;
    } else {
      this.error('Unknown SGR attribute: %d.', p);
    }
  }

  this.curAttr = (flags << 18) | (fg << 9) | bg;
};

Terminal.prototype.deviceStatus = function(params) {
  if (!this.prefix) {
    switch (params[0]) {
      case 5:
        // status report
        this.send('\x1b[0n');
        break;
      case 6:
        // cursor position
        this.send('\x1b['
          + (this.y + 1)
          + ';'
          + (this.x + 1)
          + 'R');
        break;
    }
  } else if (this.prefix === '?') {
    // modern xterm doesnt seem to
    // respond to any of these except ?6, 6, and 5
    switch (params[0]) {
      case 6:
        // cursor position
        this.send('\x1b[?'
          + (this.y + 1)
          + ';'
          + (this.x + 1)
          + 'R');
        break;
      case 15:
        // no printer
        // this.send('\x1b[?11n');
        break;
      case 25:
        // dont support user defined keys
        // this.send('\x1b[?21n');
        break;
      case 26:
        // north american keyboard
        // this.send('\x1b[?27;1;0;0n');
        break;
      case 53:
        // no dec locator/mouse
        // this.send('\x1b[?50n');
        break;
    }
  }
};

/**
 * Additions
 */

// CSI Ps @
// Insert Ps (Blank) Character(s) (default = 1) (ICH).
Terminal.prototype.insertChars = function(params) {
  var param, row, j, ch;

  param = params[0];
  if (param < 1) param = 1;

  row = this.y + this.ybase;
  j = this.x;
  ch = [this.eraseAttr(), ' ']; // xterm

  while (param-- && j < this.cols) {
    this.lines[row].splice(j++, 0, ch);
    this.lines[row].pop();
  }
};

// CSI Ps E
// Cursor Next Line Ps Times (default = 1) (CNL).
// same as CSI Ps B ?
Terminal.prototype.cursorNextLine = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.y += param;
  if (this.y >= this.rows) {
    this.y = this.rows - 1;
  }
  this.x = 0;
};

// CSI Ps F
// Cursor Preceding Line Ps Times (default = 1) (CNL).
// reuse CSI Ps A ?
Terminal.prototype.cursorPrecedingLine = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.y -= param;
  if (this.y < 0) this.y = 0;
  this.x = 0;
};

// CSI Ps G
// Cursor Character Absolute  [column] (default = [row,1]) (CHA).
Terminal.prototype.cursorCharAbsolute = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.x = param - 1;
};

// CSI Ps L
// Insert Ps Line(s) (default = 1) (IL).
Terminal.prototype.insertLines = function(params) {
  var param, row, j;

  param = params[0];
  if (param < 1) param = 1;
  row = this.y + this.ybase;

  j = this.rows - 1 - this.scrollBottom;
  j = this.rows - 1 + this.ybase - j + 1;

  while (param--) {
    // test: echo -e '\e[44m\e[1L\e[0m'
    // blankLine(true) - xterm/linux behavior
    this.lines.splice(row, 0, this.blankLine(true));
    this.lines.splice(j, 1);
  }

  // this.maxRange();
  this.updateRange(this.y);
  this.updateRange(this.scrollBottom);
};

// CSI Ps M
// Delete Ps Line(s) (default = 1) (DL).
Terminal.prototype.deleteLines = function(params) {
  var param, row, j;

  param = params[0];
  if (param < 1) param = 1;
  row = this.y + this.ybase;

  j = this.rows - 1 - this.scrollBottom;
  j = this.rows - 1 + this.ybase - j;

  while (param--) {
    // test: echo -e '\e[44m\e[1M\e[0m'
    // blankLine(true) - xterm/linux behavior
    this.lines.splice(j + 1, 0, this.blankLine(true));
    this.lines.splice(row, 1);
  }

  // this.maxRange();
  this.updateRange(this.y);
  this.updateRange(this.scrollBottom);
};

// CSI Ps P
// Delete Ps Character(s) (default = 1) (DCH).
Terminal.prototype.deleteChars = function(params) {
  var param, row, ch;

  param = params[0];
  if (param < 1) param = 1;

  row = this.y + this.ybase;
  ch = [this.eraseAttr(), ' ']; // xterm

  while (param--) {
    this.lines[row].splice(this.x, 1);
    this.lines[row].push(ch);
  }
};

// CSI Ps X
// Erase Ps Character(s) (default = 1) (ECH).
Terminal.prototype.eraseChars = function(params) {
  var param, row, j, ch;

  param = params[0];
  if (param < 1) param = 1;

  row = this.y + this.ybase;
  j = this.x;
  ch = [this.eraseAttr(), ' ']; // xterm

  while (param-- && j < this.cols) {
    this.lines[row][j++] = ch;
  }
};

// CSI Pm `  Character Position Absolute
//   [column] (default = [row,1]) (HPA).
Terminal.prototype.charPosAbsolute = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.x = param - 1;
  if (this.x >= this.cols) {
    this.x = this.cols - 1;
  }
};

// 141 61 a * HPR -
// Horizontal Position Relative
// reuse CSI Ps C ?
Terminal.prototype.HPositionRelative = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.x += param;
  if (this.x >= this.cols) {
    this.x = this.cols - 1;
  }
};

Terminal.prototype.sendDeviceAttributes = function(params) {
  if (params[0] > 0) return;

  if (!this.prefix) {
    if (this.is('xterm')
        || this.is('rxvt-unicode')
        || this.is('screen')) {
      this.send('\x1b[?1;2c');
    } else if (this.is('linux')) {
      this.send('\x1b[?6c');
    }
  } else if (this.prefix === '>') {
    // xterm and urxvt
    // seem to spit this
    // out around ~370 times (?).
    if (this.is('xterm')) {
      this.send('\x1b[>0;276;0c');
    } else if (this.is('rxvt-unicode')) {
      this.send('\x1b[>85;95;0c');
    } else if (this.is('linux')) {
      // not supported by linux console.
      // linux console echoes parameters.
      this.send(params[0] + 'c');
    } else if (this.is('screen')) {
      this.send('\x1b[>83;40003;0c');
    }
  }
};

// CSI Pm d
// Line Position Absolute  [row] (default = [1,column]) (VPA).
Terminal.prototype.linePosAbsolute = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.y = param - 1;
  if (this.y >= this.rows) {
    this.y = this.rows - 1;
  }
};

// 145 65 e * VPR - Vertical Position Relative
// reuse CSI Ps B ?
Terminal.prototype.VPositionRelative = function(params) {
  var param = params[0];
  if (param < 1) param = 1;
  this.y += param;
  if (this.y >= this.rows) {
    this.y = this.rows - 1;
  }
};

// CSI Ps ; Ps f
//   Horizontal and Vertical Position [row;column] (default =
//   [1,1]) (HVP).
Terminal.prototype.HVPosition = function(params) {
  if (params[0] < 1) params[0] = 1;
  if (params[1] < 1) params[1] = 1;

  this.y = params[0] - 1;
  if (this.y >= this.rows) {
    this.y = this.rows - 1;
  }

  this.x = params[1] - 1;
  if (this.x >= this.cols) {
    this.x = this.cols - 1;
  }
};

Terminal.prototype.setMode = function(params) {
  if (typeof params === 'object') {
    var l = params.length
      , i = 0;

    for (; i < l; i++) {
      this.setMode(params[i]);
    }

    return;
  }

  if (!this.prefix) {
    switch (params) {
      case 4:
        this.insertMode = true;
        break;
      case 20:
        //this.convertEol = true;
        break;
    }
  } else if (this.prefix === '?') {
    switch (params) {
      case 1:
        this.applicationCursor = true;
        break;
      case 2:
        this.setgCharset(0, Terminal.charsets.US);
        this.setgCharset(1, Terminal.charsets.US);
        this.setgCharset(2, Terminal.charsets.US);
        this.setgCharset(3, Terminal.charsets.US);
        // set VT100 mode here
        break;
      case 3: // 132 col mode
        this.savedCols = this.cols;
        this.resize(132, this.rows);
        break;
      case 6:
        this.originMode = true;
        break;
      case 7:
        this.wraparoundMode = true;
        break;
      case 12:
        // this.cursorBlink = true;
        break;
      case 66:
        this.log('Serial port requested application keypad.');
        this.applicationKeypad = true;
        break;
      case 9: // X10 Mouse
        // no release, no motion, no wheel, no modifiers.
      case 1000: // vt200 mouse
        // no motion.
        // no modifiers, except control on the wheel.
      case 1002: // button event mouse
      case 1003: // any event mouse
        // any event - sends motion events,
        // even if there is no button held down.
        this.x10Mouse = params === 9;
        this.vt200Mouse = params === 1000;
        this.normalMouse = params > 1000;
        this.mouseEvents = true;
        this.element.style.cursor = 'default';
        this.log('Binding to mouse events.');
        break;
      case 1004: // send focusin/focusout events
        // focusin: ^[[I
        // focusout: ^[[O
        this.sendFocus = true;
        break;
      case 1005: // utf8 ext mode mouse
        this.utfMouse = true;
        // for wide terminals
        // simply encodes large values as utf8 characters
        break;
      case 1006: // sgr ext mode mouse
        this.sgrMouse = true;
        break;
      case 1015: // urxvt ext mode mouse
        this.urxvtMouse = true;
        break;
      case 25: // show cursor
        this.cursorHidden = false;
        break;
      case 1049: // alt screen buffer cursor
        //this.saveCursor();
        ; // FALL-THROUGH
      case 47: // alt screen buffer
      case 1047: // alt screen buffer
        if (!this.normal) {
          var normal = {
            lines: this.lines,
            ybase: this.ybase,
            ydisp: this.ydisp,
            x: this.x,
            y: this.y,
            scrollTop: this.scrollTop,
            scrollBottom: this.scrollBottom,
            tabs: this.tabs
          };
          this.reset();
          this.normal = normal;
          this.showCursor();
        }
        break;
    }
  }
};

Terminal.prototype.resetMode = function(params) {
  if (typeof params === 'object') {
    var l = params.length
      , i = 0;

    for (; i < l; i++) {
      this.resetMode(params[i]);
    }

    return;
  }

  if (!this.prefix) {
    switch (params) {
      case 4:
        this.insertMode = false;
        break;
      case 20:
        //this.convertEol = false;
        break;
    }
  } else if (this.prefix === '?') {
    switch (params) {
      case 1:
        this.applicationCursor = false;
        break;
      case 3:
        if (this.cols === 132 && this.savedCols) {
          this.resize(this.savedCols, this.rows);
        }
        delete this.savedCols;
        break;
      case 6:
        this.originMode = false;
        break;
      case 7:
        this.wraparoundMode = false;
        break;
      case 12:
        // this.cursorBlink = false;
        break;
      case 66:
        this.log('Switching back to normal keypad.');
        this.applicationKeypad = false;
        break;
      case 9: // X10 Mouse
      case 1000: // vt200 mouse
      case 1002: // button event mouse
      case 1003: // any event mouse
        this.x10Mouse = false;
        this.vt200Mouse = false;
        this.normalMouse = false;
        this.mouseEvents = false;
        this.element.style.cursor = '';
        break;
      case 1004: // send focusin/focusout events
        this.sendFocus = false;
        break;
      case 1005: // utf8 ext mode mouse
        this.utfMouse = false;
        break;
      case 1006: // sgr ext mode mouse
        this.sgrMouse = false;
        break;
      case 1015: // urxvt ext mode mouse
        this.urxvtMouse = false;
        break;
      case 25: // hide cursor
        this.cursorHidden = true;
        break;
      case 1049: // alt screen buffer cursor
        ; // FALL-THROUGH
      case 47: // normal screen buffer
      case 1047: // normal screen buffer - clearing it first
        if (this.normal) {
          this.lines = this.normal.lines;
          this.ybase = this.normal.ybase;
          this.ydisp = this.normal.ydisp;
          this.x = this.normal.x;
          this.y = this.normal.y;
          this.scrollTop = this.normal.scrollTop;
          this.scrollBottom = this.normal.scrollBottom;
          this.tabs = this.normal.tabs;
          this.normal = null;
          this.refresh(0, this.rows - 1);
          this.showCursor();
        }
        break;
    }
  }
};

Terminal.prototype.setScrollRegion = function(params) {
  if (this.prefix) return;
  this.scrollTop = (params[0] || 1) - 1;
  this.scrollBottom = (params[1] || this.rows) - 1;
  this.x = 0;
  this.y = 0;
};

// CSI s
//   Save cursor (ANSI.SYS).
Terminal.prototype.saveCursor = function(params) {
  this.savedX = this.x;
  this.savedY = this.y;
};

// CSI u
//   Restore cursor (ANSI.SYS).
Terminal.prototype.restoreCursor = function(params) {
  this.x = this.savedX || 0;
  this.y = this.savedY || 0;
};

/**
 * Lesser Used
 */

// CSI Ps I
//   Cursor Forward Tabulation Ps tab stops (default = 1) (CHT).
Terminal.prototype.cursorForwardTab = function(params) {
  var param = params[0] || 1;
  while (param--) {
    this.x = this.nextStop();
  }
};

// CSI Ps S  Scroll up Ps lines (default = 1) (SU).
Terminal.prototype.scrollUp = function(params) {
  var param = params[0] || 1;
  while (param--) {
    this.lines.splice(this.ybase + this.scrollTop, 1);
    this.lines.splice(this.ybase + this.scrollBottom, 0, this.blankLine());
  }
  // this.maxRange();
  this.updateRange(this.scrollTop);
  this.updateRange(this.scrollBottom);
};

// CSI Ps T  Scroll down Ps lines (default = 1) (SD).
Terminal.prototype.scrollDown = function(params) {
  var param = params[0] || 1;
  while (param--) {
    this.lines.splice(this.ybase + this.scrollBottom, 1);
    this.lines.splice(this.ybase + this.scrollTop, 0, this.blankLine());
  }
  // this.maxRange();
  this.updateRange(this.scrollTop);
  this.updateRange(this.scrollBottom);
};

Terminal.prototype.initMouseTracking = function(params) {
  // Relevant: DECSET 1001
};

Terminal.prototype.resetTitleModes = function(params) {
  ;
};

// CSI Ps Z  Cursor Backward Tabulation Ps tab stops (default = 1) (CBT).
Terminal.prototype.cursorBackwardTab = function(params) {
  var param = params[0] || 1;
  while (param--) {
    this.x = this.prevStop();
  }
};

// CSI Ps b  Repeat the preceding graphic character Ps times (REP).
Terminal.prototype.repeatPrecedingCharacter = function(params) {
  var param = params[0] || 1
    , line = this.lines[this.ybase + this.y]
    , ch = line[this.x - 1] || [this.defAttr, ' '];

  while (param--) line[this.x++] = ch;
};

Terminal.prototype.tabClear = function(params) {
  var param = params[0];
  if (param <= 0) {
    delete this.tabs[this.x];
  } else if (param === 3) {
    this.tabs = {};
  }
};

Terminal.prototype.softReset = function(params) {
  this.cursorHidden = false;
  this.insertMode = false;
  this.originMode = false;
  this.wraparoundMode = false; // autowrap
  this.applicationKeypad = false; // ?
  this.applicationCursor = false;
  this.scrollTop = 0;
  this.scrollBottom = this.rows - 1;
  this.curAttr = this.defAttr;
  this.x = this.y = 0; // ?
  this.charset = null;
  this.glevel = 0; // ??
  this.charsets = [null]; // ??
};

Terminal.prototype.setAttrInRectangle = function(params) {
  var t = params[0]
    , l = params[1]
    , b = params[2]
    , r = params[3]
    , attr = params[4];

  var line
    , i;

  for (; t < b + 1; t++) {
    line = this.lines[this.ybase + t];
    for (i = l; i < r; i++) {
      line[i] = [attr, line[i][1]];
    }
  }

  // this.maxRange();
  this.updateRange(params[0]);
  this.updateRange(params[2]);
};

Terminal.prototype.fillRectangle = function(params) {
  var ch = params[0]
    , t = params[1]
    , l = params[2]
    , b = params[3]
    , r = params[4];

  var line
    , i;

  for (; t < b + 1; t++) {
    line = this.lines[this.ybase + t];
    for (i = l; i < r; i++) {
      line[i] = [line[i][0], String.fromCharCode(ch)];
    }
  }

  // this.maxRange();
  this.updateRange(params[1]);
  this.updateRange(params[3]);
};

Terminal.prototype.enableLocatorReporting = function(params) {
  var val = params[0] > 0;
  //this.mouseEvents = val;
  //this.decLocator = val;
};

Terminal.prototype.eraseRectangle = function(params) {
  var t = params[0]
    , l = params[1]
    , b = params[2]
    , r = params[3];

  var line
    , i
    , ch;

  ch = [this.eraseAttr(), ' ']; // xterm?

  for (; t < b + 1; t++) {
    line = this.lines[this.ybase + t];
    for (i = l; i < r; i++) {
      line[i] = ch;
    }
  }

  // this.maxRange();
  this.updateRange(params[0]);
  this.updateRange(params[2]);
};

Terminal.prototype.insertColumns = function() {
  var param = params[0]
    , l = this.ybase + this.rows
    , ch = [this.eraseAttr(), ' '] // xterm?
    , i;

  while (param--) {
    for (i = this.ybase; i < l; i++) {
      this.lines[i].splice(this.x + 1, 0, ch);
      this.lines[i].pop();
    }
  }

  this.maxRange();
};

Terminal.prototype.deleteColumns = function() {
  var param = params[0]
    , l = this.ybase + this.rows
    , ch = [this.eraseAttr(), ' '] // xterm?
    , i;

  while (param--) {
    for (i = this.ybase; i < l; i++) {
      this.lines[i].splice(this.x, 1);
      this.lines[i].push(ch);
    }
  }

  this.maxRange();
};

/**
 * Prefix/Select/Visual/Search Modes
 */

Terminal.prototype.enterPrefix = function() {
  this.prefixMode = true;
};

Terminal.prototype.leavePrefix = function() {
  this.prefixMode = false;
};

Terminal.prototype.enterSelect = function() {
  this._real = {
    x: this.x,
    y: this.y,
    ydisp: this.ydisp,
    ybase: this.ybase,
    cursorHidden: this.cursorHidden,
    lines: this.copyBuffer(this.lines),
    write: this.write
  };
  this.write = function() {};
  this.selectMode = true;
  this.visualMode = false;
  this.cursorHidden = false;
  this.refresh(this.y, this.y);
};

Terminal.prototype.leaveSelect = function() {
  this.x = this._real.x;
  this.y = this._real.y;
  this.ydisp = this._real.ydisp;
  this.ybase = this._real.ybase;
  this.cursorHidden = this._real.cursorHidden;
  this.lines = this._real.lines;
  this.write = this._real.write;
  delete this._real;
  this.selectMode = false;
  this.visualMode = false;
  this.refresh(0, this.rows - 1);
};

Terminal.prototype.enterVisual = function() {
  this._real.preVisual = this.copyBuffer(this.lines);
  this.selectText(this.x, this.x, this.ydisp + this.y, this.ydisp + this.y);
  this.visualMode = true;
};

Terminal.prototype.leaveVisual = function() {
  this.lines = this._real.preVisual;
  delete this._real.preVisual;
  delete this._selected;
  this.visualMode = false;
  this.refresh(0, this.rows - 1);
};

Terminal.prototype.enterSearch = function(down) {
  this.entry = '';
  this.searchMode = true;
  this.searchDown = down;
  this._real.preSearch = this.copyBuffer(this.lines);
  this._real.preSearchX = this.x;
  this._real.preSearchY = this.y;

  var bottom = this.ydisp + this.rows - 1;
  for (var i = 0; i < this.entryPrefix.length; i++) {
    //this.lines[bottom][i][0] = (this.defAttr & ~0x1ff) | 4;
    //this.lines[bottom][i][1] = this.entryPrefix[i];
    this.lines[bottom][i] = [
      (this.defAttr & ~0x1ff) | 4,
      this.entryPrefix[i]
    ];
  }

  this.y = this.rows - 1;
  this.x = this.entryPrefix.length;

  this.refresh(this.rows - 1, this.rows - 1);
};

Terminal.prototype.leaveSearch = function() {
  this.searchMode = false;

  if (this._real.preSearch) {
    this.lines = this._real.preSearch;
    this.x = this._real.preSearchX;
    this.y = this._real.preSearchY;
    delete this._real.preSearch;
    delete this._real.preSearchX;
    delete this._real.preSearchY;
  }

  this.refresh(this.rows - 1, this.rows - 1);
};

Terminal.prototype.copyBuffer = function(lines) {
  var lines = lines || this.lines
    , out = [];

  for (var y = 0; y < lines.length; y++) {
    out[y] = [];
    for (var x = 0; x < lines[y].length; x++) {
      out[y][x] = [lines[y][x][0], lines[y][x][1]];
    }
  }

  return out;
};

Terminal.prototype.getCopyTextarea = function(text) {
  var textarea = this._copyTextarea
    , document = this.document;

  if (!textarea) {
    textarea = document.createElement('textarea');
    textarea.style.position = 'absolute';
    textarea.style.left = '-32000px';
    textarea.style.top = '-32000px';
    textarea.style.width = '0px';
    textarea.style.height = '0px';
    textarea.style.opacity = '0';
    textarea.style.backgroundColor = 'transparent';
    textarea.style.borderStyle = 'none';
    textarea.style.outlineStyle = 'none';

    document.getElementsByTagName('body')[0].appendChild(textarea);

    this._copyTextarea = textarea;
  }

  return textarea;
};

// NOTE: Only works for primary selection on X11.
// Non-X11 users should use Ctrl-C instead.
Terminal.prototype.copyText = function(text) {
  var self = this
    , textarea = this.getCopyTextarea();

  this.emit('copy', text);

  textarea.focus();
  textarea.textContent = text;
  textarea.value = text;
  textarea.setSelectionRange(0, text.length);

  setTimeout(function() {
    self.element.focus();
    self.focus();
  }, 1);
};

Terminal.prototype.selectText = function(x1, x2, y1, y2) {
  var ox1
    , ox2
    , oy1
    , oy2
    , tmp
    , x
    , y
    , xl
    , attr;

  if (this._selected) {
    ox1 = this._selected.x1;
    ox2 = this._selected.x2;
    oy1 = this._selected.y1;
    oy2 = this._selected.y2;

    if (oy2 < oy1) {
      tmp = ox2;
      ox2 = ox1;
      ox1 = tmp;
      tmp = oy2;
      oy2 = oy1;
      oy1 = tmp;
    }

    if (ox2 < ox1 && oy1 === oy2) {
      tmp = ox2;
      ox2 = ox1;
      ox1 = tmp;
    }

    for (y = oy1; y <= oy2; y++) {
      x = 0;
      xl = this.cols - 1;
      if (y === oy1) {
        x = ox1;
      }
      if (y === oy2) {
        xl = ox2;
      }
      for (; x <= xl; x++) {
        if (this.lines[y][x].old != null) {
          //this.lines[y][x][0] = this.lines[y][x].old;
          //delete this.lines[y][x].old;
          attr = this.lines[y][x].old;
          delete this.lines[y][x].old;
          this.lines[y][x] = [attr, this.lines[y][x][1]];
        }
      }
    }

    y1 = this._selected.y1;
    x1 = this._selected.x1;
  }

  y1 = Math.max(y1, 0);
  y1 = Math.min(y1, this.ydisp + this.rows - 1);

  y2 = Math.max(y2, 0);
  y2 = Math.min(y2, this.ydisp + this.rows - 1);

  this._selected = { x1: x1, x2: x2, y1: y1, y2: y2 };

  if (y2 < y1) {
    tmp = x2;
    x2 = x1;
    x1 = tmp;
    tmp = y2;
    y2 = y1;
    y1 = tmp;
  }

  if (x2 < x1 && y1 === y2) {
    tmp = x2;
    x2 = x1;
    x1 = tmp;
  }

  for (y = y1; y <= y2; y++) {
    x = 0;
    xl = this.cols - 1;
    if (y === y1) {
      x = x1;
    }
    if (y === y2) {
      xl = x2;
    }
    for (; x <= xl; x++) {
      attr = this.lines[y][x][0];
      this.lines[y][x] = [
        (attr & ~0x1ff) | ((0x1ff << 9) | 4),
        this.lines[y][x][1]
      ];
      this.lines[y][x].old = attr;
    }
  }

  y1 = y1 - this.ydisp;
  y2 = y2 - this.ydisp;

  y1 = Math.max(y1, 0);
  y1 = Math.min(y1, this.rows - 1);

  y2 = Math.max(y2, 0);
  y2 = Math.min(y2, this.rows - 1);

  //this.refresh(y1, y2);
  this.refresh(0, this.rows - 1);
};

Terminal.prototype.grabText = function(x1, x2, y1, y2) {
  var out = ''
    , buf = ''
    , ch
    , x
    , y
    , xl
    , tmp;

  if (y2 < y1) {
    tmp = x2;
    x2 = x1;
    x1 = tmp;
    tmp = y2;
    y2 = y1;
    y1 = tmp;
  }

  if (x2 < x1 && y1 === y2) {
    tmp = x2;
    x2 = x1;
    x1 = tmp;
  }

  for (y = y1; y <= y2; y++) {
    x = 0;
    xl = this.cols - 1;
    if (y === y1) {
      x = x1;
    }
    if (y === y2) {
      xl = x2;
    }
    for (; x <= xl; x++) {
      ch = this.lines[y][x][1];
      if (ch === ' ') {
        buf += ch;
        continue;
      }
      if (buf) {
        out += buf;
        buf = '';
      }
      out += ch;
      if (isWide(ch)) x++;
    }
    buf = '';
    out += '\n';
  }

  // If we're not at the end of the
  // line, don't add a newline.
  for (x = x2, y = y2; x < this.cols; x++) {
    if (this.lines[y][x][1] !== ' ') {
      out = out.slice(0, -1);
      break;
    }
  }

  return out;
};

Terminal.prototype.keyPrefix = function(ev, key) {
  if (key === 'k' || key === '&') {
    this.destroy();
  } else if (key === 'p' || key === ']') {
    this.emit('request paste');
  } else if (key === 'c') {
    this.emit('request create');
  } else if (key >= '0' && key <= '9') {
    key = +key - 1;
    if (!~key) key = 9;
    this.emit('request term', key);
  } else if (key === 'n') {
    this.emit('request term next');
  } else if (key === 'P') {
    this.emit('request term previous');
  } else if (key === ':') {
    this.emit('request command mode');
  } else if (key === '[') {
    this.enterSelect();
  }
};

Terminal.prototype.keySelect = function(ev, key) {
  this.showCursor();

  if (this.searchMode || key === 'n' || key === 'N') {
    return this.keySearch(ev, key);
  }

  if (key === '\x04') { // ctrl-d
    var y = this.ydisp + this.y;
    if (this.ydisp === this.ybase) {
      // Mimic vim behavior
      this.y = Math.min(this.y + (this.rows - 1) / 2 | 0, this.rows - 1);
      this.refresh(0, this.rows - 1);
    } else {
      this.scrollDisp((this.rows - 1) / 2 | 0);
    }
    if (this.visualMode) {
      this.selectText(this.x, this.x, y, this.ydisp + this.y);
    }
    return;
  }

  if (key === '\x15') { // ctrl-u
    var y = this.ydisp + this.y;
    if (this.ydisp === 0) {
      // Mimic vim behavior
      this.y = Math.max(this.y - (this.rows - 1) / 2 | 0, 0);
      this.refresh(0, this.rows - 1);
    } else {
      this.scrollDisp(-(this.rows - 1) / 2 | 0);
    }
    if (this.visualMode) {
      this.selectText(this.x, this.x, y, this.ydisp + this.y);
    }
    return;
  }

  if (key === '\x06') { // ctrl-f
    var y = this.ydisp + this.y;
    this.scrollDisp(this.rows - 1);
    if (this.visualMode) {
      this.selectText(this.x, this.x, y, this.ydisp + this.y);
    }
    return;
  }

  if (key === '\x02') { // ctrl-b
    var y = this.ydisp + this.y;
    this.scrollDisp(-(this.rows - 1));
    if (this.visualMode) {
      this.selectText(this.x, this.x, y, this.ydisp + this.y);
    }
    return;
  }

  if (key === 'k' || key === '\x1b[A') {
    var y = this.ydisp + this.y;
    this.y--;
    if (this.y < 0) {
      this.y = 0;
      this.scrollDisp(-1);
    }
    if (this.visualMode) {
      this.selectText(this.x, this.x, y, this.ydisp + this.y);
    } else {
      this.refresh(this.y, this.y + 1);
    }
    return;
  }

  if (key === 'j' || key === '\x1b[B') {
    var y = this.ydisp + this.y;
    this.y++;
    if (this.y >= this.rows) {
      this.y = this.rows - 1;
      this.scrollDisp(1);
    }
    if (this.visualMode) {
      this.selectText(this.x, this.x, y, this.ydisp + this.y);
    } else {
      this.refresh(this.y - 1, this.y);
    }
    return;
  }

  if (key === 'h' || key === '\x1b[D') {
    var x = this.x;
    this.x--;
    if (this.x < 0) {
      this.x = 0;
    }
    if (this.visualMode) {
      this.selectText(x, this.x, this.ydisp + this.y, this.ydisp + this.y);
    } else {
      this.refresh(this.y, this.y);
    }
    return;
  }

  if (key === 'l' || key === '\x1b[C') {
    var x = this.x;
    this.x++;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
    }
    if (this.visualMode) {
      this.selectText(x, this.x, this.ydisp + this.y, this.ydisp + this.y);
    } else {
      this.refresh(this.y, this.y);
    }
    return;
  }

  if (key === 'v' || key === ' ') {
    if (!this.visualMode) {
      this.enterVisual();
    } else {
      this.leaveVisual();
    }
    return;
  }

  if (key === 'y') {
    if (this.visualMode) {
      var text = this.grabText(
        this._selected.x1, this._selected.x2,
        this._selected.y1, this._selected.y2);
      this.copyText(text);
      this.leaveVisual();
      // this.leaveSelect();
    }
    return;
  }

  if (key === 'q' || key === '\x1b') {
    if (this.visualMode) {
      this.leaveVisual();
    } else {
      this.leaveSelect();
    }
    return;
  }

  if (key === 'w' || key === 'W') {
    var ox = this.x;
    var oy = this.y;
    var oyd = this.ydisp;

    var x = this.x;
    var y = this.y;
    var yb = this.ydisp;
    var saw_space = false;

    for (;;) {
      var line = this.lines[yb + y];
      while (x < this.cols) {
        if (line[x][1] <= ' ') {
          saw_space = true;
        } else if (saw_space) {
          break;
        }
        x++;
      }
      if (x >= this.cols) x = this.cols - 1;
      if (x === this.cols - 1 && line[x][1] <= ' ') {
        x = 0;
        if (++y >= this.rows) {
          y--;
          if (++yb > this.ybase) {
            yb = this.ybase;
            x = this.x;
            break;
          }
        }
        continue;
      }
      break;
    }

    this.x = x, this.y = y;
    this.scrollDisp(-this.ydisp + yb);

    if (this.visualMode) {
      this.selectText(ox, this.x, oy + oyd, this.ydisp + this.y);
    }
    return;
  }

  if (key === 'b' || key === 'B') {
    var ox = this.x;
    var oy = this.y;
    var oyd = this.ydisp;

    var x = this.x;
    var y = this.y;
    var yb = this.ydisp;

    for (;;) {
      var line = this.lines[yb + y];
      var saw_space = x > 0 && line[x][1] > ' ' && line[x - 1][1] > ' ';
      while (x >= 0) {
        if (line[x][1] <= ' ') {
          if (saw_space && (x + 1 < this.cols && line[x + 1][1] > ' ')) {
            x++;
            break;
          } else {
            saw_space = true;
          }
        }
        x--;
      }
      if (x < 0) x = 0;
      if (x === 0 && (line[x][1] <= ' ' || !saw_space)) {
        x = this.cols - 1;
        if (--y < 0) {
          y++;
          if (--yb < 0) {
            yb++;
            x = 0;
            break;
          }
        }
        continue;
      }
      break;
    }

    this.x = x, this.y = y;
    this.scrollDisp(-this.ydisp + yb);

    if (this.visualMode) {
      this.selectText(ox, this.x, oy + oyd, this.ydisp + this.y);
    }
    return;
  }

  if (key === 'e' || key === 'E') {
    var x = this.x + 1;
    var y = this.y;
    var yb = this.ydisp;
    if (x >= this.cols) x--;

    for (;;) {
      var line = this.lines[yb + y];
      while (x < this.cols) {
        if (line[x][1] <= ' ') {
          x++;
        } else {
          break;
        }
      }
      while (x < this.cols) {
        if (line[x][1] <= ' ') {
          if (x - 1 >= 0 && line[x - 1][1] > ' ') {
            x--;
            break;
          }
        }
        x++;
      }
      if (x >= this.cols) x = this.cols - 1;
      if (x === this.cols - 1 && line[x][1] <= ' ') {
        x = 0;
        if (++y >= this.rows) {
          y--;
          if (++yb > this.ybase) {
            yb = this.ybase;
            break;
          }
        }
        continue;
      }
      break;
    }

    this.x = x, this.y = y;
    this.scrollDisp(-this.ydisp + yb);

    if (this.visualMode) {
      this.selectText(ox, this.x, oy + oyd, this.ydisp + this.y);
    }
    return;
  }

  if (key === '^' || key === '0') {
    var ox = this.x;

    if (key === '0') {
      this.x = 0;
    } else if (key === '^') {
      var line = this.lines[this.ydisp + this.y];
      var x = 0;
      while (x < this.cols) {
        if (line[x][1] > ' ') {
          break;
        }
        x++;
      }
      if (x >= this.cols) x = this.cols - 1;
      this.x = x;
    }

    if (this.visualMode) {
      this.selectText(ox, this.x, this.ydisp + this.y, this.ydisp + this.y);
    } else {
      this.refresh(this.y, this.y);
    }
    return;
  }

  if (key === '$') {
    var ox = this.x;
    var line = this.lines[this.ydisp + this.y];
    var x = this.cols - 1;
    while (x >= 0) {
      if (line[x][1] > ' ') {
        if (this.visualMode && x < this.cols - 1) x++;
        break;
      }
      x--;
    }
    if (x < 0) x = 0;
    this.x = x;
    if (this.visualMode) {
      this.selectText(ox, this.x, this.ydisp + this.y, this.ydisp + this.y);
    } else {
      this.refresh(this.y, this.y);
    }
    return;
  }

  if (key === 'g' || key === 'G') {
    var ox = this.x;
    var oy = this.y;
    var oyd = this.ydisp;
    if (key === 'g') {
      this.x = 0, this.y = 0;
      this.scrollDisp(-this.ydisp);
    } else if (key === 'G') {
      this.x = 0, this.y = this.rows - 1;
      this.scrollDisp(this.ybase);
    }
    if (this.visualMode) {
      this.selectText(ox, this.x, oy + oyd, this.ydisp + this.y);
    }
    return;
  }

  if (key === 'H' || key === 'M' || key === 'L') {
    var ox = this.x;
    var oy = this.y;
    if (key === 'H') {
      this.x = 0, this.y = 0;
    } else if (key === 'M') {
      this.x = 0, this.y = this.rows / 2 | 0;
    } else if (key === 'L') {
      this.x = 0, this.y = this.rows - 1;
    }
    if (this.visualMode) {
      this.selectText(ox, this.x, this.ydisp + oy, this.ydisp + this.y);
    } else {
      this.refresh(oy, oy);
      this.refresh(this.y, this.y);
    }
    return;
  }

  if (key === '{' || key === '}') {
    var ox = this.x;
    var oy = this.y;
    var oyd = this.ydisp;

    var line;
    var saw_full = false;
    var found = false;
    var first_is_space = -1;
    var y = this.y + (key === '{' ? -1 : 1);
    var yb = this.ydisp;
    var i;

    if (key === '{') {
      if (y < 0) {
        y++;
        if (yb > 0) yb--;
      }
    } else if (key === '}') {
      if (y >= this.rows) {
        y--;
        if (yb < this.ybase) yb++;
      }
    }

    for (;;) {
      line = this.lines[yb + y];

      for (i = 0; i < this.cols; i++) {
        if (line[i][1] > ' ') {
          if (first_is_space === -1) {
            first_is_space = 0;
          }
          saw_full = true;
          break;
        } else if (i === this.cols - 1) {
          if (first_is_space === -1) {
            first_is_space = 1;
          } else if (first_is_space === 0) {
            found = true;
          } else if (first_is_space === 1) {
            if (saw_full) found = true;
          }
          break;
        }
      }

      if (found) break;

      if (key === '{') {
        y--;
        if (y < 0) {
          y++;
          if (yb > 0) yb--;
          else break;
        }
      } else if (key === '}') {
        y++;
        if (y >= this.rows) {
          y--;
          if (yb < this.ybase) yb++;
          else break;
        }
      }
    }

    if (!found) {
      if (key === '{') {
        y = 0;
        yb = 0;
      } else if (key === '}') {
        y = this.rows - 1;
        yb = this.ybase;
      }
    }

    this.x = 0, this.y = y;
    this.scrollDisp(-this.ydisp + yb);

    if (this.visualMode) {
      this.selectText(ox, this.x, oy + oyd, this.ydisp + this.y);
    }
    return;
  }

  if (key === '/' || key === '?') {
    if (!this.visualMode) {
      this.enterSearch(key === '/');
    }
    return;
  }

  return false;
};

Terminal.prototype.keySearch = function(ev, key) {
  if (key === '\x1b') {
    this.leaveSearch();
    return;
  }

  if (key === '\r' || (!this.searchMode && (key === 'n' || key === 'N'))) {
    this.leaveSearch();

    var entry = this.entry;

    if (!entry) {
      this.refresh(0, this.rows - 1);
      return;
    }

    var ox = this.x;
    var oy = this.y;
    var oyd = this.ydisp;

    var line;
    var found = false;
    var wrapped = false;
    var x = this.x + 1;
    var y = this.ydisp + this.y;
    var yb, i;
    var up = key === 'N'
      ? this.searchDown
      : !this.searchDown;

    for (;;) {
      line = this.lines[y];

      while (x < this.cols) {
        for (i = 0; i < entry.length; i++) {
          if (x + i >= this.cols) break;
          if (line[x + i][1] !== entry[i]) {
            break;
          } else if (line[x + i][1] === entry[i] && i === entry.length - 1) {
            found = true;
            break;
          }
        }
        if (found) break;
        x += i + 1;
      }
      if (found) break;

      x = 0;

      if (!up) {
        y++;
        if (y > this.ybase + this.rows - 1) {
          if (wrapped) break;
          // this.setMessage('Search wrapped. Continuing at TOP.');
          wrapped = true;
          y = 0;
        }
      } else {
        y--;
        if (y < 0) {
          if (wrapped) break;
          // this.setMessage('Search wrapped. Continuing at BOTTOM.');
          wrapped = true;
          y = this.ybase + this.rows - 1;
        }
      }
    }

    if (found) {
      if (y - this.ybase < 0) {
        yb = y;
        y = 0;
        if (yb > this.ybase) {
          y = yb - this.ybase;
          yb = this.ybase;
        }
      } else {
        yb = this.ybase;
        y -= this.ybase;
      }

      this.x = x, this.y = y;
      this.scrollDisp(-this.ydisp + yb);

      if (this.visualMode) {
        this.selectText(ox, this.x, oy + oyd, this.ydisp + this.y);
      }
      return;
    }

    // this.setMessage("No matches found.");
    this.refresh(0, this.rows - 1);

    return;
  }

  if (key === '\b' || key === '\x7f') {
    if (this.entry.length === 0) return;
    var bottom = this.ydisp + this.rows - 1;
    this.entry = this.entry.slice(0, -1);
    var i = this.entryPrefix.length + this.entry.length;
    //this.lines[bottom][i][1] = ' ';
    this.lines[bottom][i] = [
      this.lines[bottom][i][0],
      ' '
    ];
    this.x--;
    this.refresh(this.rows - 1, this.rows - 1);
    this.refresh(this.y, this.y);
    return;
  }

  if (key.length === 1 && key >= ' ' && key <= '~') {
    var bottom = this.ydisp + this.rows - 1;
    this.entry += key;
    var i = this.entryPrefix.length + this.entry.length - 1;
    //this.lines[bottom][i][0] = (this.defAttr & ~0x1ff) | 4;
    //this.lines[bottom][i][1] = key;
    this.lines[bottom][i] = [
      (this.defAttr & ~0x1ff) | 4,
      key
    ];
    this.x++;
    this.refresh(this.rows - 1, this.rows - 1);
    this.refresh(this.y, this.y);
    return;
  }

  return false;
};

/**
 * Character Sets
 */

Terminal.charsets = {};

Terminal.charsets.SCLD = { // (0
  '`': '\u25c6', // '◆'
  'a': '\u2592', // '▒'
  'b': '\u0009', // '\t'
  'c': '\u000c', // '\f'
  'd': '\u000d', // '\r'
  'e': '\u000a', // '\n'
  'f': '\u00b0', // '°'
  'g': '\u00b1', // '±'
  'h': '\u2424', // '\u2424' (NL)
  'i': '\u000b', // '\v'
  'j': '\u2518', // '┘'
  'k': '\u2510', // '┐'
  'l': '\u250c', // '┌'
  'm': '\u2514', // '└'
  'n': '\u253c', // '┼'
  'o': '\u23ba', // '⎺'
  'p': '\u23bb', // '⎻'
  'q': '\u2500', // '─'
  'r': '\u23bc', // '⎼'
  's': '\u23bd', // '⎽'
  't': '\u251c', // '├'
  'u': '\u2524', // '┤'
  'v': '\u2534', // '┴'
  'w': '\u252c', // '┬'
  'x': '\u2502', // '│'
  'y': '\u2264', // '≤'
  'z': '\u2265', // '≥'
  '{': '\u03c0', // 'π'
  '|': '\u2260', // '≠'
  '}': '\u00a3', // '£'
  '~': '\u00b7'  // '·'
};

Terminal.charsets.UK = null; // (A
Terminal.charsets.US = null; // (B (USASCII)
Terminal.charsets.Dutch = null; // (4
Terminal.charsets.Finnish = null; // (C or (5
Terminal.charsets.French = null; // (R
Terminal.charsets.FrenchCanadian = null; // (Q
Terminal.charsets.German = null; // (K
Terminal.charsets.Italian = null; // (Y
Terminal.charsets.NorwegianDanish = null; // (E or (6
Terminal.charsets.Spanish = null; // (Z
Terminal.charsets.Swedish = null; // (H or (7
Terminal.charsets.Swiss = null; // (=
Terminal.charsets.ISOLatin = null; // /A

/**
 * Helpers
 */

function on(el, type, handler, capture) {
  el.addEventListener(type, handler, capture || false);
}

function off(el, type, handler, capture) {
  el.removeEventListener(type, handler, capture || false);
}

function cancel(ev) {
  if (ev.preventDefault) ev.preventDefault();
  ev.returnValue = false;
  if (ev.stopPropagation) ev.stopPropagation();
  ev.cancelBubble = true;
  return false;
}

function inherits(child, parent) {
  function f() {
    this.constructor = child;
  }
  f.prototype = parent.prototype;
  child.prototype = new f;
}

// if bold is broken, we can't
// use it in the terminal.
function isBoldBroken(document) {
  var body = document.getElementsByTagName('body')[0];
  var terminal = document.createElement('div');
  terminal.className = 'terminal';
  var line = document.createElement('div');
  var el = document.createElement('span');
  el.innerHTML = 'hello world';
  line.appendChild(el);
  terminal.appendChild(line);
  body.appendChild(terminal);
  var w1 = el.scrollWidth;
  el.style.fontWeight = 'bold';
  var w2 = el.scrollWidth;
  body.removeChild(terminal);
  return w1 !== w2;
}

var String = this.String;
var setTimeout = this.setTimeout;
var setInterval = this.setInterval;

function indexOf(obj, el) {
  var i = obj.length;
  while (i--) {
    if (obj[i] === el) return i;
  }
  return -1;
}

function isWide(ch) {
  if (ch <= '\uff00') return false;
  return (ch >= '\uff01' && ch <= '\uffbe')
      || (ch >= '\uffc2' && ch <= '\uffc7')
      || (ch >= '\uffca' && ch <= '\uffcf')
      || (ch >= '\uffd2' && ch <= '\uffd7')
      || (ch >= '\uffda' && ch <= '\uffdc')
      || (ch >= '\uffe0' && ch <= '\uffe6')
      || (ch >= '\uffe8' && ch <= '\uffee');
}

function matchColor(r1, g1, b1) {
  var hash = (r1 << 16) | (g1 << 8) | b1;

  if (matchColor._cache[hash] != null) {
    return matchColor._cache[hash];
  }

  var ldiff = Infinity
    , li = -1
    , i = 0
    , c
    , r2
    , g2
    , b2
    , diff;

  for (; i < Terminal.vcolors.length; i++) {
    c = Terminal.vcolors[i];
    r2 = c[0];
    g2 = c[1];
    b2 = c[2];

    diff = matchColor.distance(r1, g1, b1, r2, g2, b2);

    if (diff === 0) {
      li = i;
      break;
    }

    if (diff < ldiff) {
      ldiff = diff;
      li = i;
    }
  }

  return matchColor._cache[hash] = li;
}

matchColor._cache = {};

// http://stackoverflow.com/questions/1633828
matchColor.distance = function(r1, g1, b1, r2, g2, b2) {
  return Math.pow(30 * (r1 - r2), 2)
    + Math.pow(59 * (g1 - g2), 2)
    + Math.pow(11 * (b1 - b2), 2);
};

function each(obj, iter, con) {
  if (obj.forEach) return obj.forEach(iter, con);
  for (var i = 0; i < obj.length; i++) {
    iter.call(con, obj[i], i, obj);
  }
}

function keys(obj) {
  if (Object.keys) return Object.keys(obj);
  var key, keys = [];
  for (key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Expose
 */

Terminal.EventEmitter = EventEmitter;
Terminal.Stream = Stream;
Terminal.inherits = inherits;
Terminal.on = on;
Terminal.off = off;
Terminal.cancel = cancel;

if (typeof module !== 'undefined') {
  module.exports = Terminal;
} else {
  this.Terminal = Terminal;
}

}).call(function() {
  return this || (typeof window !== 'undefined' ? window : global);
}());
