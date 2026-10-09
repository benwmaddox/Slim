#ifndef SLIM_WINDOWS_GPU_H
#define SLIM_WINDOWS_GPU_H

#if SLIM_GPU_RENDERER

#define COBJMACROS
#include <d3d11.h>
#include <dxgi1_2.h>
#include "slim-gpu-shaders.h"

static const IID slim_gpu_iid_dxgi_device = {
  0x54ec77fa, 0x1377, 0x44e6,
  {0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}
};
static const IID slim_gpu_iid_factory2 = {
  0x50c83a1c, 0xe072, 0x4c48,
  {0x87, 0xb0, 0x36, 0x30, 0xfa, 0x36, 0xa6, 0xd0}
};
static const IID slim_gpu_iid_texture2d = {
  0x6f15aaf2, 0xd208, 0x4e89,
  {0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}
};
static const IID slim_gpu_iid_surface1 = {
  0x4ae63092, 0x6327, 0x4c1b,
  {0x80, 0xae, 0xbf, 0xe1, 0x2e, 0xa3, 0x2b, 0x86}
};

static HWND slim_gpu_window;
static ID3D11Device *slim_gpu_device;
static ID3D11DeviceContext *slim_gpu_context;
static IDXGISwapChain1 *slim_gpu_swapchain;
static ID3D11Texture2D *slim_gpu_backbuffer;
static IDXGISurface1 *slim_gpu_surface;
static ID3D11RenderTargetView *slim_gpu_rtv;
static ID3D11Buffer *slim_gpu_vertex_buffer;
static ID3D11InputLayout *slim_gpu_input_layout;
static ID3D11VertexShader *slim_gpu_vertex_shader;
static ID3D11PixelShader *slim_gpu_pixel_shader;
static ID3D11RasterizerState *slim_gpu_rasterizer;
static HDC slim_gpu_surface_dc;
static DXGI_ADAPTER_DESC slim_gpu_adapter_desc;
static D3D_FEATURE_LEVEL slim_gpu_feature_level;
static HRESULT slim_gpu_last_error;
static UINT slim_gpu_width;
static UINT slim_gpu_height;
static int slim_gpu_initialized;
static int slim_gpu_uses_warp;
static int slim_gpu_prefer_warp;

static void slim_gpu_zero(void *memory, SIZE_T bytes) {
  BYTE *out = (BYTE *)memory;
  SIZE_T i;
  for (i = 0; i < bytes; ++i) out[i] = 0;
}

static void slim_gpu_release_backbuffer(void) {
  if (slim_gpu_surface_dc && slim_gpu_surface) {
    IDXGISurface1_ReleaseDC(slim_gpu_surface, 0);
    slim_gpu_surface_dc = 0;
    GdiFlush();
  }
  if (slim_gpu_context) ID3D11DeviceContext_OMSetRenderTargets(slim_gpu_context, 0, 0, 0);
  if (slim_gpu_rtv) {
    ID3D11RenderTargetView_Release(slim_gpu_rtv);
    slim_gpu_rtv = 0;
  }
  if (slim_gpu_surface) {
    IDXGISurface1_Release(slim_gpu_surface);
    slim_gpu_surface = 0;
  }
  if (slim_gpu_backbuffer) {
    ID3D11Texture2D_Release(slim_gpu_backbuffer);
    slim_gpu_backbuffer = 0;
  }
}

static void slim_gpu_release_all(void) {
  slim_gpu_release_backbuffer();
  if (slim_gpu_context) {
    ID3D11DeviceContext_ClearState(slim_gpu_context);
    ID3D11DeviceContext_Flush(slim_gpu_context);
  }
  if (slim_gpu_swapchain) {
    IDXGISwapChain1_Release(slim_gpu_swapchain);
    slim_gpu_swapchain = 0;
  }
  if (slim_gpu_rasterizer) {
    ID3D11RasterizerState_Release(slim_gpu_rasterizer);
    slim_gpu_rasterizer = 0;
  }
  if (slim_gpu_pixel_shader) {
    ID3D11PixelShader_Release(slim_gpu_pixel_shader);
    slim_gpu_pixel_shader = 0;
  }
  if (slim_gpu_vertex_shader) {
    ID3D11VertexShader_Release(slim_gpu_vertex_shader);
    slim_gpu_vertex_shader = 0;
  }
  if (slim_gpu_input_layout) {
    ID3D11InputLayout_Release(slim_gpu_input_layout);
    slim_gpu_input_layout = 0;
  }
  if (slim_gpu_vertex_buffer) {
    ID3D11Buffer_Release(slim_gpu_vertex_buffer);
    slim_gpu_vertex_buffer = 0;
  }
  if (slim_gpu_context) {
    ID3D11DeviceContext_Release(slim_gpu_context);
    slim_gpu_context = 0;
  }
  if (slim_gpu_device) {
    ID3D11Device_Release(slim_gpu_device);
    slim_gpu_device = 0;
  }
  slim_gpu_initialized = 0;
  slim_gpu_width = 0;
  slim_gpu_height = 0;
}

static HRESULT slim_gpu_create_backbuffer(UINT width, UINT height) {
  HRESULT hr;
  hr = IDXGISwapChain1_GetBuffer(slim_gpu_swapchain, 0, &slim_gpu_iid_texture2d,
                                (void **)&slim_gpu_backbuffer);
  if (FAILED(hr)) return hr;
  hr = ID3D11Texture2D_QueryInterface(slim_gpu_backbuffer, &slim_gpu_iid_surface1,
                                     (void **)&slim_gpu_surface);
  if (FAILED(hr)) return hr;
  hr = ID3D11Device_CreateRenderTargetView(slim_gpu_device,
                                            (ID3D11Resource *)slim_gpu_backbuffer,
                                            0, &slim_gpu_rtv);
  if (FAILED(hr)) return hr;
  slim_gpu_width = width;
  slim_gpu_height = height;
  return S_OK;
}

static HRESULT slim_gpu_create_pipeline(void) {
  D3D11_INPUT_ELEMENT_DESC elements[2];
  D3D11_BUFFER_DESC buffer_desc;
  D3D11_RASTERIZER_DESC rasterizer_desc;
  HRESULT hr;

  elements[0].SemanticName = "POSITION";
  elements[0].SemanticIndex = 0;
  elements[0].Format = DXGI_FORMAT_R32G32_FLOAT;
  elements[0].InputSlot = 0;
  elements[0].AlignedByteOffset = 0;
  elements[0].InputSlotClass = D3D11_INPUT_PER_VERTEX_DATA;
  elements[0].InstanceDataStepRate = 0;
  elements[1].SemanticName = "COLOR";
  elements[1].SemanticIndex = 0;
  elements[1].Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  elements[1].InputSlot = 0;
  elements[1].AlignedByteOffset = 8;
  elements[1].InputSlotClass = D3D11_INPUT_PER_VERTEX_DATA;
  elements[1].InstanceDataStepRate = 0;

  hr = ID3D11Device_CreateVertexShader(slim_gpu_device, slim_gpu_vs,
                                       (SIZE_T)sizeof(slim_gpu_vs), 0,
                                       &slim_gpu_vertex_shader);
  if (FAILED(hr)) return hr;
  hr = ID3D11Device_CreatePixelShader(slim_gpu_device, slim_gpu_ps,
                                      (SIZE_T)sizeof(slim_gpu_ps), 0,
                                      &slim_gpu_pixel_shader);
  if (FAILED(hr)) return hr;
  hr = ID3D11Device_CreateInputLayout(slim_gpu_device, elements, 2,
                                      slim_gpu_vs, (SIZE_T)sizeof(slim_gpu_vs),
                                      &slim_gpu_input_layout);
  if (FAILED(hr)) return hr;

  buffer_desc.ByteWidth = 8190u * (UINT)sizeof(SlimGpuVertex);
  buffer_desc.Usage = D3D11_USAGE_DYNAMIC;
  buffer_desc.BindFlags = D3D11_BIND_VERTEX_BUFFER;
  buffer_desc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  buffer_desc.MiscFlags = 0;
  buffer_desc.StructureByteStride = 0;
  hr = ID3D11Device_CreateBuffer(slim_gpu_device, &buffer_desc, 0,
                                 &slim_gpu_vertex_buffer);
  if (FAILED(hr)) return hr;

  rasterizer_desc.FillMode = D3D11_FILL_SOLID;
  rasterizer_desc.CullMode = D3D11_CULL_NONE;
  rasterizer_desc.FrontCounterClockwise = FALSE;
  rasterizer_desc.DepthBias = 0;
  rasterizer_desc.DepthBiasClamp = 0.0f;
  rasterizer_desc.SlopeScaledDepthBias = 0.0f;
  rasterizer_desc.DepthClipEnable = TRUE;
  rasterizer_desc.ScissorEnable = FALSE;
  rasterizer_desc.MultisampleEnable = FALSE;
  rasterizer_desc.AntialiasedLineEnable = FALSE;
  hr = ID3D11Device_CreateRasterizerState(slim_gpu_device, &rasterizer_desc,
                                         &slim_gpu_rasterizer);
  return hr;
}

static HRESULT slim_gpu_create_once(HWND window, UINT width, UINT height,
                                    D3D_DRIVER_TYPE driver_type) {
  static const D3D_FEATURE_LEVEL feature_levels[] = {
    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0
  };
  IDXGIDevice *dxgi_device = 0;
  IDXGIAdapter *adapter = 0;
  IDXGIFactory2 *factory = 0;
  DXGI_SWAP_CHAIN_DESC1 swap_desc;
  D3D_FEATURE_LEVEL selected_level = D3D_FEATURE_LEVEL_10_0;
  HRESULT hr;

  slim_gpu_release_all();
  slim_gpu_window = window;
  slim_gpu_uses_warp = driver_type == D3D_DRIVER_TYPE_WARP;
  slim_gpu_adapter_desc.Description[0] = 0;
  hr = D3D11CreateDevice(0, driver_type, 0, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                         feature_levels,
                         (UINT)(sizeof(feature_levels) / sizeof(feature_levels[0])),
                         D3D11_SDK_VERSION, &slim_gpu_device, &selected_level,
                         &slim_gpu_context);
  if (FAILED(hr)) goto failed;
  slim_gpu_feature_level = selected_level;

  hr = ID3D11Device_QueryInterface(slim_gpu_device, &slim_gpu_iid_dxgi_device,
                                   (void **)&dxgi_device);
  if (FAILED(hr)) goto failed;
  hr = IDXGIDevice_GetAdapter(dxgi_device, &adapter);
  if (FAILED(hr)) goto failed;
  hr = IDXGIAdapter_GetParent(adapter, &slim_gpu_iid_factory2, (void **)&factory);
  if (FAILED(hr)) goto failed;
  if (SUCCEEDED(IDXGIAdapter_GetDesc(adapter, &slim_gpu_adapter_desc))) {
    slim_gpu_adapter_desc.Description[127] = 0;
  }
  IDXGIFactory2_MakeWindowAssociation(factory, window, DXGI_MWA_NO_ALT_ENTER);

  slim_gpu_zero(&swap_desc, sizeof(swap_desc));
  swap_desc.Width = width;
  swap_desc.Height = height;
  swap_desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  swap_desc.Stereo = FALSE;
  swap_desc.SampleDesc.Count = 1;
  swap_desc.SampleDesc.Quality = 0;
  swap_desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  swap_desc.BufferCount = 2;
  swap_desc.Scaling = DXGI_SCALING_STRETCH;
  swap_desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
  swap_desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
  swap_desc.Flags = DXGI_SWAP_CHAIN_FLAG_GDI_COMPATIBLE;
  hr = IDXGIFactory2_CreateSwapChainForHwnd(factory,
                                             (IUnknown *)slim_gpu_device,
                                             window, &swap_desc, 0, 0,
                                             &slim_gpu_swapchain);
  if (FAILED(hr)) goto failed;
  hr = slim_gpu_create_pipeline();
  if (FAILED(hr)) goto failed;
  hr = slim_gpu_create_backbuffer(width, height);
  if (FAILED(hr)) goto failed;
  slim_gpu_initialized = 1;
  slim_gpu_last_error = S_OK;
  if (factory) IDXGIFactory2_Release(factory);
  if (adapter) IDXGIAdapter_Release(adapter);
  if (dxgi_device) IDXGIDevice_Release(dxgi_device);
  return S_OK;

failed:
  slim_gpu_last_error = hr;
  if (factory) IDXGIFactory2_Release(factory);
  if (adapter) IDXGIAdapter_Release(adapter);
  if (dxgi_device) IDXGIDevice_Release(dxgi_device);
  slim_gpu_release_all();
  return hr;
}

static void slim_gpu_fit_framebuffer(UINT width, UINT height) {
  int left, top, view_width, view_height;
  slim_fit_viewport((int)width, (int)height, &left, &top, &view_width, &view_height);
  slim_surface_width = (int)width;
  slim_surface_height = (int)height;
  slim_bind_framebuffer(0, view_width, view_height, view_width);
}

static int slim_gpu_initialize(HWND window) {
  RECT client;
  UINT width, height;
  HRESULT hr;
  if (!window || !GetClientRect(window, &client)) return 0;
  width = (UINT)(client.right - client.left);
  height = (UINT)(client.bottom - client.top);
  if (!width || !height || !slim_framebuffer_size_valid((int)width, (int)height)) return 0;
  slim_gpu_window = window;
  if (slim_gpu_prefer_warp) {
    hr = slim_gpu_create_once(window, width, height, D3D_DRIVER_TYPE_WARP);
  } else {
    hr = slim_gpu_create_once(window, width, height, D3D_DRIVER_TYPE_HARDWARE);
    if (FAILED(hr)) hr = slim_gpu_create_once(window, width, height, D3D_DRIVER_TYPE_WARP);
  }
  if (FAILED(hr)) {
    slim_gpu_last_error = hr;
    slim_gpu_fit_framebuffer(width, height);
    return 0;
  }
  slim_gpu_fit_framebuffer(width, height);
  return 1;
}

static void slim_gpu_mark_device_lost(HRESULT hr) {
  slim_gpu_last_error = hr;
  slim_gpu_prefer_warp = 1;
  slim_gpu_release_all();
}

static int slim_gpu_resize_target(UINT width, UINT height) {
  HRESULT hr;
  if (!slim_gpu_initialized || !slim_gpu_swapchain || !width || !height) return 0;
  if (width == slim_gpu_width && height == slim_gpu_height) {
    slim_gpu_fit_framebuffer(width, height);
    return 1;
  }
  slim_gpu_release_backbuffer();
  hr = IDXGISwapChain1_ResizeBuffers(slim_gpu_swapchain, 0, width, height,
                                    DXGI_FORMAT_UNKNOWN,
                                    DXGI_SWAP_CHAIN_FLAG_GDI_COMPATIBLE);
  if (FAILED(hr)) {
    slim_gpu_mark_device_lost(hr);
    return 0;
  }
  hr = slim_gpu_create_backbuffer(width, height);
  if (FAILED(hr)) {
    slim_gpu_mark_device_lost(hr);
    return 0;
  }
  slim_gpu_fit_framebuffer(width, height);
  return 1;
}

static int slim_gpu_prepare_framebuffer(HWND window) {
  RECT client;
  UINT width, height;
  if (!slim_gpu_initialized) return 1;
  if (!window || !GetClientRect(window, &client)) return 0;
  width = (UINT)(client.right - client.left);
  height = (UINT)(client.bottom - client.top);
  if (!width || !height) return 0;
  return slim_gpu_resize_target(width, height);
}

static int slim_gpu_begin_target(void) {
  RECT client;
  UINT width, height;
  FLOAT clear_color[4] = {0.0f, 0.0f, 0.0f, 0.0f};
  D3D11_VIEWPORT viewport;
  int left, top, view_width, view_height;
  if (!slim_gpu_initialized) {
    if (!slim_gpu_initialize(slim_gpu_window)) return 0;
  }
  if (!slim_gpu_window || !GetClientRect(slim_gpu_window, &client)) return 0;
  width = (UINT)(client.right - client.left);
  height = (UINT)(client.bottom - client.top);
  if (!width || !height || !slim_gpu_resize_target(width, height)) return 0;
  slim_fit_viewport((int)width, (int)height, &left, &top, &view_width, &view_height);
  if (view_width <= 0 || view_height <= 0) return 0;
  ID3D11DeviceContext_OMSetRenderTargets(slim_gpu_context, 1, &slim_gpu_rtv, 0);
  ID3D11DeviceContext_ClearRenderTargetView(slim_gpu_context, slim_gpu_rtv, clear_color);
  viewport.TopLeftX = (FLOAT)left;
  viewport.TopLeftY = (FLOAT)top;
  viewport.Width = (FLOAT)view_width;
  viewport.Height = (FLOAT)view_height;
  viewport.MinDepth = 0.0f;
  viewport.MaxDepth = 1.0f;
  ID3D11DeviceContext_RSSetViewports(slim_gpu_context, 1, &viewport);
  ID3D11DeviceContext_RSSetState(slim_gpu_context, slim_gpu_rasterizer);
  ID3D11DeviceContext_IASetInputLayout(slim_gpu_context, slim_gpu_input_layout);
  ID3D11DeviceContext_IASetPrimitiveTopology(slim_gpu_context,
                                              D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  ID3D11DeviceContext_VSSetShader(slim_gpu_context, slim_gpu_vertex_shader, 0, 0);
  ID3D11DeviceContext_PSSetShader(slim_gpu_context, slim_gpu_pixel_shader, 0, 0);
  return 1;
}

static int slim_gpu_flush_vertices(const SlimGpuVertex *vertices, uint32_t count) {
  D3D11_MAPPED_SUBRESOURCE mapped;
  UINT stride = (UINT)sizeof(SlimGpuVertex), offset = 0;
  uint32_t i;
  HRESULT hr;
  if (!count) return 1;
  if (!slim_gpu_initialized || !vertices || count > 8190u || count % 3u) return 0;
  hr = ID3D11DeviceContext_Map(slim_gpu_context,
                               (ID3D11Resource *)slim_gpu_vertex_buffer,
                               0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
  if (FAILED(hr)) {
    slim_gpu_last_error = hr;
    return 0;
  }
  for (i = 0; i < count; ++i) {
    ((SlimGpuVertex *)mapped.pData)[i] = vertices[i];
  }
  ID3D11DeviceContext_Unmap(slim_gpu_context,
                            (ID3D11Resource *)slim_gpu_vertex_buffer, 0);
  ID3D11DeviceContext_IASetVertexBuffers(slim_gpu_context, 0, 1,
                                          &slim_gpu_vertex_buffer, &stride, &offset);
  ID3D11DeviceContext_Draw(slim_gpu_context, count, 0);
  return 1;
}

static int slim_gpu_finish_render(void) {
  return slim_gpu_finish_frame();
}

static HDC slim_gpu_get_surface_dc(void) {
  HDC dc = 0;
  HRESULT hr;
  if (!slim_gpu_surface || slim_gpu_surface_dc) return 0;
  hr = IDXGISurface1_GetDC(slim_gpu_surface, FALSE, &dc);
  if (FAILED(hr)) {
    slim_gpu_last_error = hr;
    return 0;
  }
  slim_gpu_surface_dc = dc;
  return dc;
}

static int slim_gpu_release_surface_dc(void) {
  HRESULT hr;
  if (!slim_gpu_surface || !slim_gpu_surface_dc) return 0;
  hr = IDXGISurface1_ReleaseDC(slim_gpu_surface, 0);
  slim_gpu_surface_dc = 0;
  GdiFlush();
  if (FAILED(hr)) {
    slim_gpu_last_error = hr;
    return 0;
  }
  return 1;
}

static HRESULT slim_gpu_present(void) {
  HRESULT hr;
  if (!slim_gpu_initialized || !slim_gpu_swapchain || slim_gpu_surface_dc) return E_FAIL;
  hr = IDXGISwapChain1_Present(slim_gpu_swapchain, 0, 0);
  if (FAILED(hr)) slim_gpu_mark_device_lost(hr);
  return hr;
}

static int slim_gpu_write_info(void) {
  HANDLE file;
  DWORD written;
  char utf8_name[512];
  int converted;
  const char *mode = slim_gpu_uses_warp ? "warp\n" : "hardware\n";
  file = CreateFileA("slim-gpu-info.txt", GENERIC_WRITE, FILE_SHARE_READ, 0,
                     CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  if (file == INVALID_HANDLE_VALUE) return 0;
  if (!WriteFile(file, "driver=", 7, &written, 0) || written != 7 ||
      !WriteFile(file, mode, (DWORD)lstrlenA(mode), &written, 0)) {
    CloseHandle(file);
    return 0;
  }
  converted = WideCharToMultiByte(CP_UTF8, 0, slim_gpu_adapter_desc.Description,
                                  -1, utf8_name, sizeof(utf8_name), 0, 0);
  if (converted <= 0) utf8_name[0] = 0;
  if (!WriteFile(file, "adapter=", 8, &written, 0) || written != 8 ||
      (utf8_name[0] && (!WriteFile(file, utf8_name, (DWORD)(converted - 1), &written, 0) ||
                        written != (DWORD)(converted - 1))) ||
      !WriteFile(file, "\nfeature-level=", 15, &written, 0) || written != 15) {
    CloseHandle(file);
    return 0;
  }
  {
    char digits[16];
    int count = 0;
    uint32_t value = (uint32_t)slim_gpu_feature_level;
    do {
      digits[count++] = (char)('0' + value % 10u);
      value /= 10u;
    } while (value && count < (int)sizeof(digits));
    while (count > 0) {
      char digit = digits[--count];
      if (!WriteFile(file, &digit, 1, &written, 0) || written != 1) {
        CloseHandle(file);
        return 0;
      }
    }
  }
  if (!WriteFile(file, "\nlast-hr=", 9, &written, 0) || written != 9) {
    CloseHandle(file);
    return 0;
  }
  {
    char digits[16];
    int count = 0;
    uint32_t value = (uint32_t)slim_gpu_last_error;
    int i;
    for (i = 0; i < 8; ++i) {
      static const char hex[] = "0123456789ABCDEF";
      digits[i] = hex[(value >> (28 - i * 4)) & 15u];
    }
    if (!WriteFile(file, digits, 8, &written, 0) || written != 8 ||
        !WriteFile(file, "\n", 1, &written, 0) || written != 1) {
      CloseHandle(file);
      return 0;
    }
  }
  CloseHandle(file);
  return 1;
}

#endif

#endif
