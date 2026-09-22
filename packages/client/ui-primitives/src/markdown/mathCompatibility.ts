/**
 * Extend upstream dollar-only math syntax with the TeX delimiters while reusing
 * the upstream token types (`mathFlow`, `mathFlowValue`, `mathText`) that
 * `mdast-util-math` compiles. This module owns the whole `$$` block form:
 * upstream closes a block only on a line-initial `$$`, so a fence ending a
 * content line runs to the end of the document, and a block that never closes
 * becomes one formula holding the rest of the reply. Here a fence closes the
 * block at the end of any content line, a block that never closes stays literal
 * text, and the opening line's remainder stays formula content instead of being
 * dropped.
 */

import { factorySpace } from 'micromark-factory-space'
import { math } from 'micromark-extension-math'
import { markdownLineEnding, markdownSpace } from 'micromark-util-character'
import { codes, constants, types } from 'micromark-util-symbol'
import type { Construct, Extension, Previous, State, Tokenizer } from 'micromark-util-types'

// oxlint-disable typescript/no-this-alias -- micromark binds tokenizer context only on the outer callback.

const previousBackslash: Previous = function (code) {
  if (code !== codes.backslash) return true
  const tail = this.events.at(-1)
  /* v8 ignore next -- a previous code necessarily has a preceding event. */
  if (tail === undefined) return false
  return tail[1].type === types.characterEscape
}

const tokenizeBackslashMathText: Tokenizer = function (effects, ok, nok) {
  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- the text construct is dispatched only for a backslash. */
    if (code !== codes.backslash) return nok(code)
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    return open
  }

  function open(code: number | null): State | undefined {
    if (code !== codes.leftParenthesis) return nok(code)
    effects.consume(code)
    effects.exit('mathTextSequence')
    return between
  }

  function between(code: number | null): State | undefined {
    if (code === codes.eof) return nok(code)
    if (code === codes.backslash) {
      return effects.attempt({ partial: true, tokenize: tokenizeClose }, close, afterCloseAttempt)(code)
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      return between
    }
    return dataStart(code)
  }

  function afterCloseAttempt(code: number | null): State | undefined {
    return effects.check({ partial: true, tokenize: tokenizeOpen }, nok, dataStart)(code)
  }

  function dataStart(code: number | null): State | undefined {
    effects.enter('mathTextData')
    effects.consume(code)
    return code === codes.backslash ? afterDataBackslash : data
  }

  function afterDataBackslash(code: number | null): State | undefined {
    if (code === codes.backslash) {
      effects.consume(code)
      return data
    }
    return data(code)
  }

  function data(code: number | null): State | undefined {
    if (code === codes.eof || code === codes.backslash || markdownLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    effects.consume(code)
    return data
  }

  function close(code: number | null): State | undefined {
    effects.exit('mathText')
    return ok(code)
  }

  function tokenizeClose(closeEffects: Parameters<Tokenizer>[0], closeOk: State, closeNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- this partial construct is attempted only at a backslash. */
      if (code !== codes.backslash) return closeNok(code)
      closeEffects.enter('mathTextSequence')
      closeEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.rightParenthesis) return closeNok(code)
      closeEffects.consume(code)
      closeEffects.exit('mathTextSequence')
      return closeOk
    }
  }

  function tokenizeOpen(openEffects: Parameters<Tokenizer>[0], openOk: State, openNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- the opening check follows a failed close attempt at a backslash. */
      if (code !== codes.backslash) return openNok(code)
      openEffects.enter(types.chunkString)
      openEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.leftParenthesis) return openNok(code)
      openEffects.consume(code)
      openEffects.exit(types.chunkString)
      return openOk
    }
  }
}

type MathFlowOptions = {
  concrete: boolean
  onlyAt?: ReadonlySet<number>
  excludeAt?: ReadonlySet<number>
}

function createMathFlow(
  marker: number,
  openMarker: number,
  closeMarker: number,
  options: MathFlowOptions = { concrete: true },
): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const self = this
    let oddBackslashRun = false
    let atLineStart = false
    const tail = self.events.at(-1)
    const initialSize = tail?.[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0

    return start

    function start(code: number | null): State | undefined {
      /* v8 ignore next -- the flow construct is dispatched only for its marker. */
      if (code !== marker) return nok(code)
      const offset = self.now().offset
      if (options.onlyAt !== undefined && !options.onlyAt.has(offset)) return nok(code)
      if (options.excludeAt?.has(offset)) return nok(code)
      effects.enter('mathFlow')
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return open
    }

    function open(code: number | null): State | undefined {
      if (code !== openMarker) return nok(code)
      effects.consume(code)
      return marker === codes.dollarSign ? afterDollarOpen : endFence
    }

    function afterDollarOpen(code: number | null): State | undefined {
      if (code !== codes.dollarSign) return endFence(code)
      effects.consume(code)
      return longerDollarOpen
    }

    function longerDollarOpen(code: number | null): State | undefined {
      if (code === codes.dollarSign) {
        effects.consume(code)
        return longerDollarOpen
      }
      if (markdownSpace(code)) {
        effects.consume(code)
        return longerDollarOpenTrailing
      }
      // A longer fence opens a block only when its line ends after it, so
      // upstream's inline `$$$…$$$` text math keeps working.
      if (markdownLineEnding(code) || code === codes.eof) return endFence(code)
      return nok(code)
    }

    function longerDollarOpenTrailing(code: number | null): State | undefined {
      if (markdownSpace(code)) {
        effects.consume(code)
        return longerDollarOpenTrailing
      }
      if (markdownLineEnding(code) || code === codes.eof) return endFence(code)
      return nok(code)
    }

    function endFence(code: number | null): State | undefined {
      effects.exit('mathFlowFenceSequence')
      effects.exit('mathFlowFence')
      return content(code)
    }

    function content(code: number | null): State | undefined {
      if (code === codes.eof) return nok(code)
      if (code === marker && (marker !== codes.dollarSign || !oddBackslashRun)) {
        return effects.attempt(
          { partial: true, tokenize: tokenizeClosingFence },
          closed,
          afterClosingFenceAttempt,
        )(code)
      }
      if (markdownLineEnding(code)) {
        // A backslash run ends at the line ending; carrying it into the next line
        // would skip that line's closing-fence attempt and fail-fast bail.
        oddBackslashRun = false
        return effects.attempt(nonLazyContinuation, afterContinuation, nok)(code)
      }
      return valueStart(code)
    }

    function afterClosingFenceAttempt(code: number | null): State | undefined {
      // A fence that starts its line instead of closing this block means the block
      // never closed: fail so the text stays literal instead of a formula. A
      // mid-line `$$` stays content, because formulas contain it.
      return atLineStart
        ? effects.check({ partial: true, tokenize: tokenizeOpeningFence }, nok, markerValueStart)(code)
        : markerValueStart(code)
    }

    function afterContinuation(code: number | null): State | undefined {
      atLineStart = true
      return effects.attempt(
        { partial: true, tokenize: tokenizeClosingFence },
        closed,
        initialSize
          ? factorySpace(effects, content, types.linePrefix, initialSize + 1)
          : content,
      )(code)
    }

    function valueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      atLineStart = false
      oddBackslashRun = code === codes.backslash
      effects.consume(code)
      return value
    }

    function markerValueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      atLineStart = false
      oddBackslashRun = false
      effects.consume(code)
      return valueAfterMarker
    }

    function valueAfterMarker(code: number | null): State | undefined {
      if (code === marker) {
        effects.consume(code)
        return value
      }
      return value(code)
    }

    function value(code: number | null): State | undefined {
      if (code === codes.eof || code === marker || markdownLineEnding(code)) {
        effects.exit('mathFlowValue')
        return content(code)
      }
      oddBackslashRun = code === codes.backslash ? !oddBackslashRun : false
      effects.consume(code)
      return value
    }

    function closed(code: number | null): State | undefined {
      effects.exit('mathFlow')
      return ok(code)
    }

    function tokenizeClosingFence(
      closeEffects: Parameters<Tokenizer>[0],
      closeOk: State,
      closeNok: State,
    ): State {
      return factorySpace(closeEffects, sequenceStart, types.linePrefix, constants.tabSize)

      function sequenceStart(code: number | null): State | undefined {
        if (code !== marker) return closeNok(code)
        closeEffects.enter('mathFlowFence')
        closeEffects.enter('mathFlowFenceSequence')
        closeEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== closeMarker) return closeNok(code)
        closeEffects.consume(code)
        return closingRun
      }

      function closingRun(code: number | null): State | undefined {
        // A longer dollar fence closes the block too, as the upstream fence run
        // does; the backslash form keeps its exact `\]`. The space factory runs
        // here rather than being returned, because this state is entered on a
        // code it does not consume itself.
        if (marker === codes.dollarSign && code === closeMarker) {
          closeEffects.consume(code)
          return closingRun
        }
        closeEffects.exit('mathFlowFenceSequence')
        return factorySpace(closeEffects, after, types.whitespace)(code)
      }

      function after(code: number | null): State | undefined {
        if (code !== codes.eof && !markdownLineEnding(code)) return closeNok(code)
        closeEffects.exit('mathFlowFence')
        return closeOk(code)
      }
    }

    function tokenizeOpeningFence(
      openEffects: Parameters<Tokenizer>[0],
      openOk: State,
      openNok: State,
    ): State {
      return sequenceStart

      function sequenceStart(code: number | null): State | undefined {
        /* v8 ignore next -- the opening check follows a failed close attempt at the marker. */
        if (code !== marker) return openNok(code)
        openEffects.enter(types.chunkString)
        openEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== openMarker) return openNok(code)
        openEffects.consume(code)
        openEffects.exit(types.chunkString)
        return openOk
      }
    }
  }

  return {
    concrete: options.concrete,
    name: marker === codes.dollarSign
      ? (options.concrete ? 'dollarMathFlow' : 'dollarMathFlowFallback')
      : (options.concrete ? 'backslashMathFlow' : 'backslashMathFlowFallback'),
    tokenize,
  }
}

const tokenizeNonLazyContinuation: Tokenizer = function (effects, ok, nok) {
  const self = this

  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (code === codes.eof) return ok(code)
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (!markdownLineEnding(code)) return nok(code)
    effects.enter(types.lineEnding)
    effects.consume(code)
    effects.exit(types.lineEnding)
    return lineStart
  }

  function lineStart(code: number | null): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code)
  }
}

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation,
}

const backslashMathText: Construct = {
  name: 'backslashMathText',
  previous: previousBackslash,
  tokenize: tokenizeBackslashMathText,
}

// Upstream reads the rest of an opening `$$` line as the `mathFlowFenceMeta`
// token and drops it; keeping that text as formula content is what lets a block
// start on the opening line, at the cost that a `$$asciimath` meta string now
// renders as part of the formula.
const compatibilityText = { ...math({ singleDollarTextMath: false }).text, [codes.backslash]: backslashMathText }

function createCompatibilityMath(fallbackOffsets?: ReadonlySet<number>): Extension {
  const hasFallbacks = fallbackOffsets !== undefined && fallbackOffsets.size > 0
  const backslashMathFlow = createMathFlow(
    codes.backslash,
    codes.leftSquareBracket,
    codes.rightSquareBracket,
    hasFallbacks ? { concrete: true, excludeAt: fallbackOffsets } : undefined,
  )
  const dollarMathFlow = createMathFlow(
    codes.dollarSign,
    codes.dollarSign,
    codes.dollarSign,
    hasFallbacks ? { concrete: true, excludeAt: fallbackOffsets } : undefined,
  )
  return {
    flow: {
      [codes.backslash]: hasFallbacks
        ? [
          createMathFlow(codes.backslash, codes.leftSquareBracket, codes.rightSquareBracket, {
            concrete: false,
            onlyAt: fallbackOffsets,
          }),
          backslashMathFlow,
        ]
        : backslashMathFlow,
      [codes.dollarSign]: hasFallbacks
        ? [
          createMathFlow(codes.dollarSign, codes.dollarSign, codes.dollarSign, {
            concrete: false,
            onlyAt: fallbackOffsets,
          }),
          dollarMathFlow,
        ]
        : dollarMathFlow,
    },
    // Upstream's inline-dollar text math; its `$$` flow construct is replaced by
    // `dollarMathFlow` above.
    text: compatibilityText,
  }
}

const compatibilityMath = createCompatibilityMath()

/** Options for recovering Markdown after a failed math-flow attempt. */
export type MathCompatibilityOptions = {
  /** Offsets where a known-unclosed delimiter should use a non-concrete flow. */
  fallbackOffsets?: ReadonlySet<number>
}

/**
 * TeX backslash delimiters, `$$` blocks, and upstream's inline-dollar text math
 * as a micromark syntax extension reusing `micromark-extension-math`'s token
 * types; the caller must register `mathFromMarkdown()` on the same parse so the
 * emitted tokens compile to standard math nodes, and must not also register
 * upstream `math()`, whose `$$` flow construct micromark would then try first
 * and run to the end of the document again.
 * @param options - Optional offsets that need a non-concrete fallback.
 * @returns The micromark syntax extension, the same object when no options are given.
 */
export function mathCompatibility(options?: MathCompatibilityOptions): Extension {
  const fallbackOffsets = options?.fallbackOffsets
  return fallbackOffsets === undefined || fallbackOffsets.size === 0
    ? compatibilityMath
    : createCompatibilityMath(fallbackOffsets)
}
