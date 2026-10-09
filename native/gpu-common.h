#ifndef SLIM_NATIVE_GPU_COMMON_H
#define SLIM_NATIVE_GPU_COMMON_H

#include <stddef.h>
#include <stdint.h>

#ifndef SLIM_GPU_RENDERER
#define SLIM_GPU_RENDERER 0
#endif

typedef struct SlimGpuVertex {
  float x;
  float y;
  uint32_t rgba;
} SlimGpuVertex;

_Static_assert(sizeof(SlimGpuVertex) == 12, "SlimGpuVertex must stay tightly packed");
_Static_assert(offsetof(SlimGpuVertex, x) == 0, "SlimGpuVertex.x ABI offset changed");
_Static_assert(offsetof(SlimGpuVertex, y) == 4, "SlimGpuVertex.y ABI offset changed");
_Static_assert(offsetof(SlimGpuVertex, rgba) == 8, "SlimGpuVertex.rgba ABI offset changed");

#if SLIM_GPU_RENDERER
#define SLIM_GPU_VERTEX_CAPACITY 8190u

static int slim_gpu_begin_target(void);
static int slim_gpu_flush_vertices(const SlimGpuVertex *vertices, uint32_t count);

static SlimGpuVertex slim_gpu_vertices[SLIM_GPU_VERTEX_CAPACITY];
static uint32_t slim_gpu_vertex_count;
static int slim_gpu_frame_failed;
static int slim_gpu_target_ready;

static uint32_t slim_gpu_pack_rgba(uint32_t rgb, uint8_t alpha) {
  uint32_t red = (rgb >> 16) & 255u;
  uint32_t green = (rgb >> 8) & 255u;
  uint32_t blue = rgb & 255u;
  return red | (green << 8) | (blue << 16) | ((uint32_t)alpha << 24);
}

static uint8_t slim_gpu_alpha_byte(float alpha) {
  if (!slim_is_finite(alpha) || !(alpha > 0.0f)) return 0;
  if (alpha >= 1.0f) return 255u;
  return (uint8_t)(alpha * 255.0f + 0.5f);
}

static void slim_gpu_begin_frame(void) {
  slim_gpu_vertex_count = 0;
  slim_gpu_frame_failed = 0;
  slim_gpu_target_ready = 0;
  if (!slim_gpu_begin_target()) {
    slim_gpu_frame_failed = 1;
    return;
  }
  slim_gpu_target_ready = 1;
}

static int slim_gpu_flush_pending(void) {
  uint32_t count = slim_gpu_vertex_count;
  if (slim_gpu_frame_failed) return 0;
  if (!count) return 1;
  if (!slim_gpu_flush_vertices(slim_gpu_vertices, count)) {
    slim_gpu_frame_failed = 1;
    slim_gpu_vertex_count = 0;
    return 0;
  }
  slim_gpu_vertex_count = 0;
  return 1;
}

static int slim_gpu_queue_vertices(const SlimGpuVertex *vertices, uint32_t count) {
  uint32_t index;
  if (slim_gpu_frame_failed || !slim_gpu_target_ready || (!vertices && count)) return 0;
  while (count) {
    uint32_t available = SLIM_GPU_VERTEX_CAPACITY - slim_gpu_vertex_count;
    uint32_t copy_count = count < available ? count : available;
    for (index = 0; index < copy_count; ++index) {
      slim_gpu_vertices[slim_gpu_vertex_count + index] = vertices[index];
    }
    slim_gpu_vertex_count += copy_count;
    vertices += copy_count;
    count -= copy_count;
    if (slim_gpu_vertex_count == SLIM_GPU_VERTEX_CAPACITY && !slim_gpu_flush_pending()) return 0;
  }
  return 1;
}

static float slim_gpu_ndc_x(float physical_x) {
  return 2.0f * physical_x / (float)slim_fb_width - 1.0f;
}

static float slim_gpu_ndc_y(float physical_y) {
  return 1.0f - 2.0f * physical_y / (float)slim_fb_height;
}

static void slim_gpu_append_triangle(float x0, float y0, float x1, float y1,
                                     float x2, float y2, uint32_t rgb, uint8_t alpha) {
  SlimGpuVertex triangle[3];
  uint32_t rgba;
  if (slim_gpu_frame_failed || !slim_gpu_target_ready || slim_fb_width <= 0 || slim_fb_height <= 0) return;
  triangle[0].x = slim_gpu_ndc_x(x0);
  triangle[0].y = slim_gpu_ndc_y(y0);
  triangle[1].x = slim_gpu_ndc_x(x1);
  triangle[1].y = slim_gpu_ndc_y(y1);
  triangle[2].x = slim_gpu_ndc_x(x2);
  triangle[2].y = slim_gpu_ndc_y(y2);
  if (!slim_is_finite(triangle[0].x) || !slim_is_finite(triangle[0].y) ||
      !slim_is_finite(triangle[1].x) || !slim_is_finite(triangle[1].y) ||
      !slim_is_finite(triangle[2].x) || !slim_is_finite(triangle[2].y)) return;
  rgba = slim_gpu_pack_rgba(rgb, alpha);
  triangle[0].rgba = rgba;
  triangle[1].rgba = rgba;
  triangle[2].rgba = rgba;
  slim_gpu_queue_vertices(triangle, 3u);
}

static void slim_gpu_append_rect(int x0, int y0, int x1, int y1,
                                 uint32_t rgb, uint8_t alpha) {
  slim_gpu_append_triangle((float)x0, (float)y0, (float)x1, (float)y0,
                           (float)x1, (float)y1, rgb, alpha);
  slim_gpu_append_triangle((float)x0, (float)y0, (float)x1, (float)y1,
                           (float)x0, (float)y1, rgb, alpha);
}

static int slim_gpu_finish_frame(void) {
  return slim_gpu_flush_pending();
}
#endif

#endif
