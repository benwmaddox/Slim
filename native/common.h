#ifndef SLIM_NATIVE_COMMON_H
#define SLIM_NATIVE_COMMON_H

#include <stdint.h>
#include <math.h>

extern const char *const slim_texts[];
extern const uint32_t slim_text_count;
float slim_init(void);
float slim_frame(void);
float slim_tri(float, float, float, float, float, float, float, float, float);
float slim_sound(float, float, float);
float slim_input(float);
float slim_text(float, float, float, float, float);
float slim_sin(float);
float slim_cos(float);
float slim_atan2(float, float);
float slim_pow(float, float);
float slim_floor(float);
float slim_ceil(float);
float slim_trunc(float);
float slim_sqrt(float);
float slim_abs(float);
float slim_min(float, float);
float slim_max(float, float);
void slim_trap(void);

#ifndef SLIM_HAS_TRI
#define SLIM_HAS_TRI 1
#endif
#ifndef SLIM_HAS_SOUND
#define SLIM_HAS_SOUND 1
#endif
#ifndef SLIM_HAS_INPUT
#define SLIM_HAS_INPUT 1
#endif
#ifndef SLIM_HAS_TEXT
#define SLIM_HAS_TEXT 1
#endif

#ifndef SLIM_SYSTEM_TEXT
#define SLIM_SYSTEM_TEXT 0
#endif

typedef uint32_t slim_u32;

static slim_u32 *slim_framebuffer;
static int slim_fb_width;
static int slim_fb_height;
static int slim_fb_stride;

#define SLIM_AUDIO_RATE 22050
#define SLIM_AUDIO_VOICES 8

static void slim_bind_framebuffer(slim_u32 *pixels, int width, int height, int stride) {
  slim_framebuffer = pixels;
  slim_fb_width = width;
  slim_fb_height = height;
  slim_fb_stride = stride;
}

static int slim_framebuffer_size_valid(int width, int height) {
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 &&
         (uint64_t)(unsigned int)width * (uint64_t)(unsigned int)height <= 16777216ull;
}

static void slim_fit_viewport(int width, int height, int *left, int *top,
                              int *view_width, int *view_height) {
  int w = 0, h = 0;
  if (width > 0 && height > 0) {
    if ((int64_t)width * 3 > (int64_t)height * 4) {
      h = height;
      w = height * 4 / 3;
    } else {
      w = width;
      h = width * 3 / 4;
    }
  }
  *view_width = w;
  *view_height = h;
  *left = (width - w) / 2;
  *top = (height - h) / 2;
}

static slim_u32 slim_float_bits(float value) {
  union { float f; slim_u32 u; } bits;
  bits.f = value;
  return bits.u;
}

static int slim_is_finite(float value) {
  return (slim_float_bits(value) & 0x7f800000u) != 0x7f800000u;
}

static float slim_bits_float(slim_u32 value) {
  union { float f; slim_u32 u; } bits;
  bits.u = value;
  return bits.f;
}

static void slim_clear(void) {
  int y;
  if (!slim_framebuffer || slim_fb_width <= 0 || slim_fb_height <= 0 || slim_fb_stride < slim_fb_width) return;
  for (y = 0; y < slim_fb_height; ++y) {
    int x;
    slim_u32 *row = slim_framebuffer + y * slim_fb_stride;
    for (x = 0; x < slim_fb_width; ++x) row[x] = 0;
  }
}

static float slim_clamp01(float value) {
  if (!(value > 0.0f)) return 0.0f;
  if (value >= 1.0f) return 1.0f;
  return value;
}

static slim_u32 slim_rgb(float r, float g, float b) {
  slim_u32 red = (slim_u32)(slim_clamp01(r) * 255.0f + 0.5f);
  slim_u32 green = (slim_u32)(slim_clamp01(g) * 255.0f + 0.5f);
  slim_u32 blue = (slim_u32)(slim_clamp01(b) * 255.0f + 0.5f);
  return (red << 16) | (green << 8) | blue;
}

static void slim_rect_pixels(int x0, int y0, int x1, int y1, slim_u32 color) {
  int x, y;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > slim_fb_width) x1 = slim_fb_width;
  if (y1 > slim_fb_height) y1 = slim_fb_height;
  if (x0 >= x1 || y0 >= y1) return;
  for (y = y0; y < y1; ++y) {
    slim_u32 *row = slim_framebuffer + y * slim_fb_stride;
    for (x = x0; x < x1; ++x) row[x] = color;
  }
}

static void slim_rect(float x, float y, float width, float height, slim_u32 color) {
  float sx = (float)slim_fb_width / 800.0f;
  float sy = (float)slim_fb_height / 600.0f;
  float left, right, top, bottom;
  int x0, y0, x1, y1;
  if (!slim_framebuffer || !slim_fb_width || !slim_fb_height ||
      !slim_is_finite(x) || !slim_is_finite(y) || !slim_is_finite(width) || !slim_is_finite(height)) return;
  left = x * sx;
  right = (x + width) * sx;
  top = y * sy;
  bottom = (y + height) * sy;
  if (!slim_is_finite(left) || !slim_is_finite(right) || !slim_is_finite(top) || !slim_is_finite(bottom) ||
      right <= 0.0f || bottom <= 0.0f || left >= (float)slim_fb_width || top >= (float)slim_fb_height) return;
  if (left < 0.0f) left = 0.0f;
  if (top < 0.0f) top = 0.0f;
  if (right > (float)slim_fb_width) right = (float)slim_fb_width;
  if (bottom > (float)slim_fb_height) bottom = (float)slim_fb_height;
  x0 = (int)left;
  y0 = (int)top;
  x1 = (int)(right + 0.999f);
  y1 = (int)(bottom + 0.999f);
  slim_rect_pixels(x0, y0, x1, y1, color);
}

static float slim_min3(float a, float b, float c) {
  float result = a < b ? a : b;
  return result < c ? result : c;
}

static float slim_max3(float a, float b, float c) {
  float result = a > b ? a : b;
  return result > c ? result : c;
}

static void slim_raster_triangle(float x0, float y0, float x1, float y1,
                                 float x2, float y2, slim_u32 color) {
  float sx = (float)slim_fb_width / 800.0f;
  float sy = (float)slim_fb_height / 600.0f;
  if (!slim_framebuffer || !slim_fb_width || !slim_fb_height ||
      !slim_is_finite(x0) || !slim_is_finite(y0) || !slim_is_finite(x1) ||
      !slim_is_finite(y1) || !slim_is_finite(x2) || !slim_is_finite(y2)) return;
  float ax = x0 * sx, ay = y0 * sy;
  float bx = x1 * sx, by = y1 * sy;
  float cx = x2 * sx, cy = y2 * sy;
  float area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  float min_x, max_x, min_y, max_y;
  float slope_ab = by == ay ? 0.0f : (bx - ax) / (by - ay);
  float slope_bc = cy == by ? 0.0f : (cx - bx) / (cy - by);
  float slope_ca = ay == cy ? 0.0f : (ax - cx) / (ay - cy);
  int iy0, iy1, y;
  if (!slim_is_finite(ax) || !slim_is_finite(ay) || !slim_is_finite(bx) ||
      !slim_is_finite(by) || !slim_is_finite(cx) || !slim_is_finite(cy) ||
      !slim_is_finite(area) || area == 0.0f) return;
  min_x = slim_min3(ax, bx, cx);
  max_x = slim_max3(ax, bx, cx);
  min_y = slim_min3(ay, by, cy);
  max_y = slim_max3(ay, by, cy);
  if (!slim_is_finite(min_x) || !slim_is_finite(max_x) ||
      !slim_is_finite(min_y) || !slim_is_finite(max_y)) return;
  if (max_x <= 0.0f || max_y <= 0.0f || min_x >= (float)slim_fb_width || min_y >= (float)slim_fb_height) return;
  iy0 = min_y <= 0.0f ? 0 : (int)ceilf(min_y - 0.5f);
  iy1 = max_y >= (float)slim_fb_height ? slim_fb_height : (int)floorf(max_y - 0.5f) + 1;
  for (y = iy0; y < iy1; ++y) {
    float scan_y = (float)y + 0.5f;
    float span_min = 0.0f, span_max = 0.0f;
    int intersections = 0, ix0, ix1, x;
    float edge_x;
    if (ay == by) {
      if (scan_y == ay) {
        span_min = ax < bx ? ax : bx;
        span_max = ax > bx ? ax : bx;
        intersections = 2;
      }
    } else if (scan_y >= (ay < by ? ay : by) && scan_y <= (ay > by ? ay : by)) {
      edge_x = ax + (scan_y - ay) * slope_ab;
      if (slim_is_finite(edge_x)) { span_min = span_max = edge_x; intersections = 1; }
    }
    if (by == cy) {
      if (scan_y == by) {
        float lo = bx < cx ? bx : cx, hi = bx > cx ? bx : cx;
        if (!intersections) { span_min = lo; span_max = hi; intersections = 2; }
        else { if (lo < span_min) span_min = lo; if (hi > span_max) span_max = hi; intersections += 2; }
      }
    } else if (scan_y >= (by < cy ? by : cy) && scan_y <= (by > cy ? by : cy)) {
      edge_x = bx + (scan_y - by) * slope_bc;
      if (slim_is_finite(edge_x)) {
        if (!intersections) { span_min = span_max = edge_x; intersections = 1; }
        else { if (edge_x < span_min) span_min = edge_x; if (edge_x > span_max) span_max = edge_x; ++intersections; }
      }
    }
    if (cy == ay) {
      if (scan_y == cy) {
        float lo = cx < ax ? cx : ax, hi = cx > ax ? cx : ax;
        if (!intersections) { span_min = lo; span_max = hi; intersections = 2; }
        else { if (lo < span_min) span_min = lo; if (hi > span_max) span_max = hi; intersections += 2; }
      }
    } else if (scan_y >= (cy < ay ? cy : ay) && scan_y <= (cy > ay ? cy : ay)) {
      edge_x = cx + (scan_y - cy) * slope_ca;
      if (slim_is_finite(edge_x)) {
        if (!intersections) { span_min = span_max = edge_x; intersections = 1; }
        else { if (edge_x < span_min) span_min = edge_x; if (edge_x > span_max) span_max = edge_x; ++intersections; }
      }
    }
    if (intersections < 2 || span_max < 0.0f || span_min >= (float)slim_fb_width) continue;
    if (span_min < 0.0f) span_min = 0.0f;
    if (span_max > (float)slim_fb_width) span_max = (float)slim_fb_width;
    ix0 = (int)ceilf(span_min - 0.5f);
    ix1 = (int)floorf(span_max - 0.5f) + 1;
    if (ix0 < 0) ix0 = 0;
    if (ix1 > slim_fb_width) ix1 = slim_fb_width;
    if (ix0 >= ix1) continue;
    slim_u32 *row = slim_framebuffer + y * slim_fb_stride;
    for (x = ix0; x < ix1; ++x) row[x] = color;
  }
}

float slim_tri(float x0, float y0, float x1, float y1, float x2, float y2,
               float r, float g, float b) {
  slim_raster_triangle(x0, y0, x1, y1, x2, y2, slim_rgb(r, g, b));
  return 0.0f;
}

/* These wrappers preserve Slim's f32 boundary while using the platform's
   double math functions, like JS Math and the WASM host path. Small platform
   rounding differences can remain. Windows imports these dynamically. */
float slim_sin(float value) { return (float)sin((double)value); }
float slim_cos(float value) { return (float)cos((double)value); }
float slim_atan2(float y, float x) { return (float)atan2((double)y, (double)x); }
float slim_pow(float base, float exponent) {
  if (exponent == 0.0f && base != 1.0f) return 1.0f;
  if (base != base || exponent != exponent) return slim_bits_float(0x7fc00000u);
  if ((base == 1.0f || base == -1.0f) && !slim_is_finite(exponent)) return slim_bits_float(0x7fc00000u);
  return (float)pow((double)base, (double)exponent);
}
float slim_floor(float value) { return (float)floor((double)value); }
float slim_ceil(float value) { return (float)ceil((double)value); }
float slim_trunc(float value) { return (float)trunc((double)value); }
float slim_sqrt(float value) { return (float)sqrt((double)value); }

static int slim_is_nan(float value) { return value != value; }
float slim_abs(float value) { return slim_bits_float(slim_float_bits(value) & 0x7fffffffu); }
float slim_min(float a, float b) {
  if (slim_is_nan(a) || slim_is_nan(b)) return slim_bits_float(0x7fc00000u);
  if (a < b) return a;
  if (b < a) return b;
  if (a == 0.0f && b == 0.0f) {
    return slim_bits_float((slim_float_bits(a) | slim_float_bits(b)) & 0x80000000u);
  }
  return a;
}
float slim_max(float a, float b) {
  if (slim_is_nan(a) || slim_is_nan(b)) return slim_bits_float(0x7fc00000u);
  if (a > b) return a;
  if (b > a) return b;
  if (a == 0.0f && b == 0.0f) {
    return slim_bits_float((slim_float_bits(a) & slim_float_bits(b)) & 0x80000000u);
  }
  return a;
}

typedef struct SlimVoiceSpec {
  float note;
  float sweep;
  float delay;
  float duration;
  float gain;
  int wave;
} SlimVoiceSpec;

typedef struct SlimVoice {
  int active;
  int wave;
  float age;
  float delay;
  float duration;
  float pitch_hz;
  float end_hz;
  float gain;
  float phase;
} SlimVoice;

static const SlimVoiceSpec slim_sound_specs[] = {
  {0.0f, 7.0f, 0.0f, 0.14f, 0.85f, 1},
  {12.0f, -2.0f, 0.0f, 0.15f, 0.72f, 1}, {19.0f, -4.0f, 0.035f, 0.12f, 0.42f, 0},
  {0.0f, -12.0f, 0.0f, 0.25f, 0.82f, 3},
  {0.0f, 0.0f, 0.0f, 0.34f, 0.52f, 0}, {4.0f, 0.0f, 0.055f, 0.32f, 0.48f, 0},
  {7.0f, 0.0f, 0.11f, 0.30f, 0.42f, 1}, {12.0f, 0.0f, 0.165f, 0.28f, 0.32f, 0},
  {7.0f, 4.0f, 0.0f, 0.20f, 0.52f, 1}, {12.0f, 0.0f, 0.07f, 0.24f, 0.38f, 0}
};
static const unsigned char slim_sound_starts[] = {0, 1, 3, 4, 8};
static const unsigned char slim_sound_lengths[] = {1, 2, 1, 4, 2};
static SlimVoice slim_voices[SLIM_AUDIO_VOICES];
static volatile int slim_audio_lock_word;

static void slim_audio_lock(void) {
  while (__sync_lock_test_and_set(&slim_audio_lock_word, 1)) { }
}
static void slim_audio_unlock(void) { __sync_lock_release(&slim_audio_lock_word); }

float slim_sound(float id_value, float pitch, float gain) {
  int id, i, voice_index;
  float p, g;
  const SlimVoiceSpec *spec;
  if (!(gain > 0.0f)) return 0.0f;
  p = slim_is_finite(pitch) ? pitch : 0.0f;
  if (p < -48.0f) p = -48.0f;
  if (p > 48.0f) p = 48.0f;
  g = gain > 1.0f ? 1.0f : gain;
  if (!slim_is_finite(id_value)) id = 0;
  else id = (int)fmod((double)id_value, 5.0);
  if (id < 0) id += 5;
  slim_audio_lock();
  for (i = 0; i < slim_sound_lengths[id]; ++i) {
    int j;
    voice_index = -1;
    for (j = 0; j < SLIM_AUDIO_VOICES; ++j) {
      if (!slim_voices[j].active) { voice_index = j; break; }
    }
    if (voice_index < 0) {
      int oldest = 0;
      for (j = 1; j < SLIM_AUDIO_VOICES; ++j) {
        if (slim_voices[j].age > slim_voices[oldest].age) oldest = j;
      }
      voice_index = oldest;
    }
    spec = slim_sound_specs + slim_sound_starts[id] + i;
    slim_voices[voice_index].active = 1;
    slim_voices[voice_index].wave = spec->wave;
    slim_voices[voice_index].age = 0.0f;
    slim_voices[voice_index].delay = spec->delay;
    slim_voices[voice_index].duration = spec->duration;
    slim_voices[voice_index].pitch_hz = 220.0f * (float)pow(2.0, (double)(p + spec->note) / 12.0);
    slim_voices[voice_index].end_hz = slim_voices[voice_index].pitch_hz * (float)pow(2.0, (double)spec->sweep / 12.0);
    slim_voices[voice_index].gain = g * spec->gain;
    slim_voices[voice_index].phase = 0.0f;
  }
  slim_audio_unlock();
  return 0.0f;
}

static float slim_wave_shape(float phase, int wave) {
  float t;
  if (wave == 1) return 1.0f - 4.0f * (phase < 0.5f ? phase : 1.0f - phase);
  if (wave == 2) return phase < 0.5f ? 1.0f : -1.0f;
  if (wave == 3) return 2.0f * phase - 1.0f;
  if (phase < 0.5f) {
    t = phase * 2.0f;
    return 4.0f * t * (1.0f - t);
  }
  t = (phase - 0.5f) * 2.0f;
  return -4.0f * t * (1.0f - t);
}

static void slim_mix_audio(float *output, int sample_count, int sample_rate) {
  int i, j;
  float step = 1.0f / (float)sample_rate;
  slim_audio_lock();
  for (i = 0; i < sample_count; ++i) {
    float mixed = 0.0f;
    for (j = 0; j < SLIM_AUDIO_VOICES; ++j) {
      SlimVoice *voice = slim_voices + j;
      if (voice->active) {
        if (voice->age >= voice->delay && voice->age < voice->delay + voice->duration) {
          float elapsed = voice->age - voice->delay;
          float t = elapsed / voice->duration;
          float attack = voice->duration < 0.03f ? voice->duration * 0.2f : 0.006f;
          float envelope;
          float hz = voice->pitch_hz + (voice->end_hz - voice->pitch_hz) * t;
          voice->phase += hz * step;
          if (voice->phase >= 1.0f) voice->phase -= (float)(int)voice->phase;
          if (elapsed < attack) envelope = 0.0001f + (voice->gain - 0.0001f) * (elapsed / attack);
          else envelope = voice->gain + (0.0001f - voice->gain) * ((elapsed - attack) / (voice->duration - attack));
          mixed += slim_wave_shape(voice->phase, voice->wave) * envelope;
        }
        voice->age += step;
        if (voice->age >= voice->delay + voice->duration + 0.025f) voice->active = 0;
      }
    }
    if (mixed > 1.0f) mixed = 1.0f;
    if (mixed < -1.0f) mixed = -1.0f;
    output[i] = mixed;
  }
  slim_audio_unlock();
}

#if SLIM_HAS_TEXT && !SLIM_SYSTEM_TEXT
static const unsigned char slim_font[47][5] = {
  {0x7e,0x11,0x11,0x11,0x7e}, {0x7f,0x49,0x49,0x49,0x36}, {0x3e,0x41,0x41,0x41,0x22},
  {0x7f,0x41,0x41,0x22,0x1c}, {0x7f,0x49,0x49,0x49,0x41}, {0x7f,0x09,0x09,0x09,0x01},
  {0x3e,0x41,0x49,0x49,0x7a}, {0x7f,0x08,0x08,0x08,0x7f}, {0x00,0x41,0x7f,0x41,0x00},
  {0x20,0x40,0x41,0x3f,0x01}, {0x7f,0x08,0x14,0x22,0x41}, {0x7f,0x40,0x40,0x40,0x40},
  {0x7f,0x02,0x04,0x02,0x7f}, {0x7f,0x04,0x08,0x10,0x7f}, {0x3e,0x41,0x41,0x41,0x3e},
  {0x7f,0x09,0x09,0x09,0x06}, {0x3e,0x41,0x51,0x21,0x5e}, {0x7f,0x09,0x19,0x29,0x46},
  {0x46,0x49,0x49,0x49,0x31}, {0x01,0x01,0x7f,0x01,0x01}, {0x3f,0x40,0x40,0x40,0x3f},
  {0x1f,0x20,0x40,0x20,0x1f}, {0x3f,0x40,0x38,0x40,0x3f}, {0x63,0x14,0x08,0x14,0x63},
  {0x07,0x08,0x70,0x08,0x07}, {0x61,0x51,0x49,0x45,0x43},
  {0x3e,0x51,0x49,0x45,0x3e}, {0x00,0x42,0x7f,0x40,0x00}, {0x42,0x61,0x51,0x49,0x46},
  {0x21,0x41,0x45,0x4b,0x31}, {0x18,0x14,0x12,0x7f,0x10}, {0x27,0x45,0x45,0x45,0x39},
  {0x3c,0x4a,0x49,0x49,0x30}, {0x01,0x71,0x09,0x05,0x03}, {0x36,0x49,0x49,0x49,0x36},
  {0x06,0x49,0x49,0x29,0x1e}, {0x00,0x36,0x36,0x00,0x00}, {0x00,0x00,0x5f,0x00,0x00},
  {0x02,0x01,0x51,0x09,0x06}, {0x00,0x60,0x60,0x00,0x00}, {0x00,0x40,0x20,0x00,0x00},
  {0x08,0x08,0x08,0x08,0x08}, {0x20,0x10,0x08,0x04,0x02}, {0x08,0x08,0x3e,0x08,0x08},
  {0x00,0x01,0x03,0x00,0x00}, {0x00,0x00,0x14,0x00,0x00}, {0,0,0,0,0}
};

static int slim_font_index(unsigned char c) {
  if (c == ' ') return 46;
  if (c >= 'a' && c <= 'z') c = (unsigned char)(c - 'a' + 'A');
  if (c >= 'A' && c <= 'Z') return (int)(c - 'A');
  if (c >= '0' && c <= '9') return 26 + (int)(c - '0');
  if (c == ':') return 36;
  if (c == '!') return 37;
  if (c == '?') return 38;
  if (c == '.') return 39;
  if (c == ',') return 40;
  if (c == '-') return 41;
  if (c == '/') return 42;
  if (c == '+') return 43;
  if (c == '\'') return 44;
  return 38;
}

static int slim_utf8_char(const unsigned char **cursor) {
  unsigned char c = *(*cursor)++;
  if (c == 0xc2 && **cursor == 0xb7) { ++*cursor; return 45; }
  if (c >= 0x80) return 38;
  return slim_font_index(c);
}

float slim_text(float id_value, float x, float y, float size, float tone) {
  int id;
  int length = 0, i, pass, row, col;
  const unsigned char *cursor;
  const char *text;
  float cell, left, top, pad;
  slim_u32 foreground, outline = 0x00080a16u;
  static const slim_u32 tones[4] = {0x00ffffffu, 0x00f4c04au, 0x007ee8a2u, 0x008d9ac0u};
  int tone_index;
  if (!slim_is_finite(id_value) || !slim_is_finite(x) || !slim_is_finite(y) ||
      !slim_is_finite(size) || !slim_is_finite(tone) || size <= 0.0f) return 0.0f;
  if (id_value < -1.0f || id_value > (float)slim_text_count) return 0.0f;
  id = (int)id_value;
  tone_index = tone < 0.0f || tone >= 4.0f ? 0 : (int)tone;
  if (id < 0 || (uint32_t)id >= slim_text_count) return 0.0f;
  text = slim_texts[id];
  if (!text) return 0.0f;
  for (cursor = (const unsigned char *)text; *cursor; ) { slim_utf8_char(&cursor); ++length; }
  if (!length) return 0.0f;
  foreground = tones[tone_index];
  cell = size / 7.0f;
  left = x - ((float)(length * 6 - 1) * cell) * 0.5f;
  top = y - size * 0.78f;
  pad = cell * 0.20f;
  for (pass = 0; pass < 2; ++pass) {
    cursor = (const unsigned char *)text;
    for (i = 0; i < length; ++i) {
      int glyph = slim_utf8_char(&cursor);
      for (col = 0; col < 5; ++col) {
        unsigned char bits = slim_font[glyph][col];
        for (row = 0; row < 7; ++row) {
          if (bits & (1u << row)) {
            float gx = left + (float)(i * 6 + col) * cell;
            float gy = top + (float)row * cell;
            if (pass == 0) slim_rect(gx - pad, gy - pad, cell + 2.0f * pad, cell + 2.0f * pad, outline);
            else slim_rect(gx, gy, cell, cell, foreground);
          }
        }
      }
    }
    pad = 0.0f;
  }
  return 0.0f;
}
#endif

#endif
