import { describe, expect, it } from 'vitest'
import {
  isQuotaExceededError,
  isTransientRateLimitError,
  extractRetryDelayMs,
} from '../src/error.ts'

describe('Layer 1 Error Classification & Transient Rate Limit (#5465)', () => {
  describe('isQuotaExceededError (Permanent Account Failure)', () => {
    it('identifies true permanent quota/balance exhaustion', () => {
      expect(isQuotaExceededError('OpenAI API error: insufficient_quota')).toBe(true)
      expect(isQuotaExceededError('You exceeded your current quota, please check your plan and billing details.')).toBe(true)
      expect(isQuotaExceededError('Your account balance is exhausted')).toBe(true)
      expect(isQuotaExceededError('out of credits')).toBe(true)
    })

    it('does NOT misclassify transient per-minute rate limits as permanent quota errors', () => {
      // Gemini 429 per-minute rate limit text:
      const gemini429 = "Quota exceeded for quota metric 'GenerateContentPaidTierInputTokensPerModelPerMinute' quotaId: GenerateContentPaidTierInputTokensPerModelPerMinute-PaidTier2 retryDelay: 10s"
      expect(isQuotaExceededError(gemini429)).toBe(false)

      const anthropicRpm = 'Rate limit reached: 50 requests per minute. retry-after: 5s'
      expect(isQuotaExceededError(anthropicRpm)).toBe(false)
    })
  })

  describe('isTransientRateLimitError', () => {
    it('identifies transient rate limits with retry hints', () => {
      const gemini429 = 'RESOURCE_EXHAUSTED quotaId: GenerateContentPaidTierInputTokensPerModelPerMinute-PaidTier2 retryDelay: 10s'
      expect(isTransientRateLimitError(gemini429)).toBe(true)
      expect(isTransientRateLimitError('HTTP 429: Too Many Requests')).toBe(true)
      expect(isTransientRateLimitError('rate_limit_exceeded')).toBe(true)
    })

    it('does not classify permanent errors as transient even if gateway attaches Retry-After header', () => {
      expect(isTransientRateLimitError('401 Unauthorized: bad key')).toBe(false)
      expect(isTransientRateLimitError('400 Invalid assistant message')).toBe(false)
      expect(isTransientRateLimitError('insufficient_quota')).toBe(false)
      // Reverse proxy / Gateway attaching Retry-After to terminal quota depletion
      expect(isTransientRateLimitError('HTTP 429 Retry-After: 3600 - Your balance is exhausted: insufficient_quota')).toBe(false)
      expect(isQuotaExceededError('HTTP 429 Retry-After: 3600 - Your balance is exhausted: insufficient_quota')).toBe(true)
    })

    it.each([
      ['Azure OpenAI TPM Throttle', 'Requests to the ChatCompletions_Create Operation have exceeded token rate limit of your current OpenAI S0 - tier. retry-after: 20', true],
      ['AWS Bedrock ThrottlingException', 'ThrottlingException: Too many requests, please wait before retrying. resets in 5s', true],
      ['Groq Rate Limit', 'rate_limit_exceeded: Rate limit reached for model `llama-3` in organization `org`: Limit 30, Used 30, Requested 1. Please try again in 2s.', true],
      ['Cloudflare Gateway 429', 'error: 429 Too Many Requests (retry-after: 10)', true],
    ])('correctly classifies %s as transient rate limit', (_name, rawError, expected) => {
      expect(isTransientRateLimitError(rawError)).toBe(expected)
      expect(isQuotaExceededError(rawError)).toBe(false)
    })
  })

  describe('extractRetryDelayMs', () => {
    it('extracts seconds delay from Gemini retryDelay format', () => {
      expect(extractRetryDelayMs('quotaId: ... retryDelay: 10s')).toBe(10000)
      expect(extractRetryDelayMs('retryDelay: 1.5s')).toBe(1500)
    })

    it('extracts milliseconds delay from retryDelay format', () => {
      expect(extractRetryDelayMs('retryDelay: 500ms')).toBe(500)
    })

    it('extracts Retry-After header format', () => {
      expect(extractRetryDelayMs('HTTP 429 Retry-After: 15')).toBe(15000)
    })

    it('returns undefined when no delay hint is present', () => {
      expect(extractRetryDelayMs('HTTP 429: slow down')).toBeUndefined()
    })
  })
})
