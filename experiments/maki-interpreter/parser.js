const { COMMANDS } = require("./constants");
const Variable = require("./variable");
const MAGIC = "FG";
const ENCODING = "binary";

const PRIMITIVE_TYPES = {
  5: "BOOLEAN",
  2: "INT",
  3: "FLOAT",
  4: "DOUBLE",
  6: "STRING"
};

// Holds a buffer and a pointer. Consumers can consume bytesoff the end of the
// file. When we want to run in the browser, we can refactor this class to use a
// typed array: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Typed_arrays
class MakiFile {
  constructor(buffer) {
    this._buffer = buffer;
    this._i = 0;
  }

  readUInt32LE() {
    const int = this._buffer.readUInt32LE(this._i);
    this._i += 4;
    return int;
  }

  readUInt16LE() {
    const int = this._buffer.readUInt16LE(this._i);
    this._i += 2;
    return int;
  }

  readUInt8() {
    const int = this._buffer.readUInt8(this._i);
    this._i++;
    return int;
  }

  readStringOfLength(length) {
    const str = this._buffer.toString(ENCODING, this._i, this._i + length);
    this._i += length;
    return str;
  }

  readString() {
    return this.readStringOfLength(this.readUInt16LE());
  }

  getNextNBytesDEPRECATED(length) {
    const bytes = this._buffer.slice(this._i, this._i + length);
    this._i += lengthn;
    return bytes;
  }
}

function readMagic(makiFile) {
  const magic = makiFile.readStringOfLength(MAGIC.length);
  if (magic !== MAGIC) {
    throw new Error("Magic number does not mach. Is this a maki file?");
  }
  return magic;
}

function readVersion(makiFile) {
  // No idea what we're actually expecting here.
  return makiFile.readUInt16LE();
}

function readClasses(makiFile) {
  let count = makiFile.readUInt32LE();
  const classes = [];
  while (count--) {
    let identifier = "";
    let chunks = 4;
    while (chunks--) {
      identifier += makiFile
        .readUInt32LE()
        .toString(16)
        .padStart(8, "0");
    }
    classes.push(identifier);
  }
  return classes;
}

function readMethods(makiFile) {
  let count = makiFile.readUInt32LE();
  const methods = [];
  while (count--) {
    const classCode = makiFile.readUInt16LE();
    // Offset into our parsed types
    const typeOffset = classCode & 0xff;
    // This is probably the second half of a uint32
    const dummy2 = makiFile.readUInt16LE();
    const name = makiFile.readString();
    methods.push({ dummy2, name, typeOffset });
  }
  return methods;
}

function readVariables({ makiFile, classes }) {
  let count = makiFile.readUInt32LE();
  const variables = [];
  while (count--) {
    const typeOffset = makiFile.readUInt8();
    const object = makiFile.readUInt8();
    const subClass = makiFile.readUInt16LE();
    const uinit1 = makiFile.readUInt16LE();
    const uinit2 = makiFile.readUInt16LE();
    const uinit3 = makiFile.readUInt16LE();
    const uinit4 = makiFile.readUInt16LE();
    const global = makiFile.readUInt8();
    const system = makiFile.readUInt8();
    const props = {
      typeOffset,
      object,
      subClass,
      uinit1,
      uinit2,
      uinit3,
      uinit4,
      global,
      system
    };

    if (object) {
      const klass = classes[typeOffset];
      if (klass == null) {
        throw new Error("Invalid type");
      }
      variables.push(
        new Variable({ ...props, type: klass, typeName: "OBJECT" })
      );
    } else if (subClass) {
      const variable = variables[typeOffset];
      if (variable == null) {
        throw new Error("Invalid type");
      }
      variables.push(
        new Variable({ ...props, type: variable, typeName: "SUBCLASS" })
      );
    } else {
      const typeName = PRIMITIVE_TYPES[typeOffset];
      if (typeName == null) {
        throw new Error("Invalid type");
      }
      let value = null;

      switch (typeName) {
        // BOOLEAN
        case PRIMITIVE_TYPES[5]:
        // INT
        case PRIMITIVE_TYPES[2]:
          value = uinit1;
          break;
        case PRIMITIVE_TYPES[3]:
        case PRIMITIVE_TYPES[4]:
          const exponent = (uinit2 & 0xff80) >> 7;
          const mantisse = ((0x80 | (uinit2 & 0x7f)) << 16) | uinit1;
          value = mantisse * 2.0 ** (exponent - 0x96);
          break;
        case PRIMITIVE_TYPES[6]:
          // This will likely get set by constants later on.
          break;
        default:
          throw new Error("Invalid primitive type");
      }
      const variable = new Variable({ ...props, type: typeName, typeName });
      variable.setValue(value);
      variables.push(variable);
    }
  }
  return variables;
}

function readConstants({ makiFile, variables }) {
  let count = makiFile.readUInt32LE();
  while (count--) {
    const i = makiFile.readUInt32LE();
    const variable = variables[i];
    const value = makiFile.readString();
    // TODO: Don't mutate
    variable.setValue(value);
  }
}

function readBindings(makiFile) {
  let count = makiFile.readUInt32LE();
  const bindings = [];
  while (count--) {
    const variableOffset = makiFile.readUInt32LE();
    const methodOffset = makiFile.readUInt32LE();
    const binaryOffset = makiFile.readUInt32LE();
    bindings.push({ variableOffset, binaryOffset, methodOffset });
  }
  return bindings;
}

function decodeCode({ makiFile, classes, variables, methods, bindings }) {
  const length = makiFile.readUInt32LE();
  const commandsBuffer = makiFile.getNextNBytesDEPRECATED(length);

  let pos = 0;
  const localFunctions = {};
  const results = [];
  while (pos < commandsBuffer.length) {
    const command = parseComand({
      commandsBuffer,
      pos,
      classes,
      variables,
      methods,
      localFunctions
    });
    pos += command._size;
    results.push(command);
  }
  // TODO: Don't mutate
  Object.values(localFunctions).forEach(localFunction => {
    bindings.push(localFunction);
  });

  bindings.sort((a, b) => {
    return a.binaryOffset - b.binaryOffset;
  });

  return results;
}

// TODO: Refactor this to consume bytes directly off the end of MakiFile
function parseComand({ commandsBuffer, pos, localFunctions }) {
  const command = {};
  const opcode = commandsBuffer.readInt8(pos);
  command.offset = pos;
  command.pos = pos;
  command.opcode = opcode;
  command.arguments = [];
  command.command = COMMANDS[opcode];
  command._size = 1;

  if (command.command == null) {
    throw new Error(`Unknown opcode "${opcode}"`);
  }

  if (command.command.arg == null) {
    command._size = 1;
    return command;
  }

  const argType = command.command.arg;
  let arg = null;
  switch (argType) {
    case "var": {
      arg = commandsBuffer.readUInt32LE(pos + 1);
      break;
    }
    case "line": {
      arg = commandsBuffer.readUInt32LE(pos + 1) + 5;
      break;
    }
    case "objFunc": {
      // TODO: ClassesOffset
      arg = commandsBuffer.readUInt32LE(pos + 1);
      break;
    }
    case "func": {
      // Note in the perl code here: "todo, something strange going on here..."
      const variable = commandsBuffer.readUInt32LE(pos + 1) + 5;
      const offset = variable + pos;
      arg = {
        name: `func${offset}`,
        code: [],
        offset
      };
      if (localFunctions[offset] == null) {
        localFunctions[offset] = {
          function: arg,
          offset
        };
      }
      break;
    }
    case "obj": {
      // Classes Offset
      arg = commandsBuffer.readUInt32LE(pos + 1);
      break;
    }
  }

  command.arguments = [arg];
  command._size = 5;

  // From perl: look forward for a stack protection block
  // (why do I have to look FORWARD. stupid nullsoft)
  if (
    commandsBuffer.length > pos + 5 + 4 &&
    commandsBuffer.readUInt32LE(pos + 5) >= 0xffff0000
  ) {
    command._size += 4;
  }

  if (opcode === 112) {
    command._size += 1;
  }
  return command;
}

function parse(buffer) {
  const makiFile = new MakiFile(buffer);

  const magic = readMagic(makiFile);
  readVersion(makiFile);
  makiFile.readUInt32LE(); // Not sure what we are skipping over here. Just some UInt 32.
  const classes = readClasses(makiFile);
  const methods = readMethods(makiFile);
  const variables = readVariables({ makiFile: makiFile, classes });
  readConstants({ makiFile: makiFile, variables });
  const bindings = readBindings(makiFile);
  const commands = decodeCode({
    makiFile: makiFile,
    classes,
    variables,
    methods,
    bindings
  });

  // Map binary offsets to command indexes.
  // Some bindings/functions ask us to jump to a place in the binary data and
  // start executing. However, we want to do all the parsing up front, and just
  // return a list of commands. This map allows anything that mentions a binary
  // offset to find the command they should jump to.
  const offsetToCommand = {};
  commands.forEach((command, i) => {
    if (command.offset != null) {
      offsetToCommand[command.offset] = i;
    }
  });

  const resolvedBindings = bindings.map(binding => {
    const { binaryOffset, ...rest } = binding;
    return {
      commandOffset: offsetToCommand[binaryOffset],
      ...rest
    };
  });
  return {
    magic,
    classes,
    methods,
    variables,
    bindings: resolvedBindings,
    commands
  };
}

module.exports = parse;