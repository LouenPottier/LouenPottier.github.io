# Videos
Place MP4 files here.

Convert from GIF:
  ffmpeg -i input.gif -movflags faststart -pix_fmt yuv420p output.mp4

Compress an existing MP4:
  ffmpeg -i input.mp4 -crf 28 -movflags faststart output.mp4

Current expected files:
- structural-dynamics.mp4
