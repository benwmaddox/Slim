struct SlimGpuVertexInput {
  float2 position : POSITION;
  float4 color : COLOR0;
};

struct SlimGpuPixelInput {
  float4 position : SV_POSITION;
  float4 color : COLOR0;
};

SlimGpuPixelInput slim_vs(SlimGpuVertexInput input) {
  SlimGpuPixelInput output;
  output.position = float4(input.position, 0.0f, 1.0f);
  output.color = input.color;
  return output;
}

float4 slim_ps(SlimGpuPixelInput input) : SV_TARGET {
  return input.color;
}
