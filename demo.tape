# Records docs/assets/demo.gif — a scripted, deterministic OpenCLI session.
# Render with:  vhs demo.tape   (requires vhs, ffmpeg, ttyd, node)
# The session itself is hand-authored in scripts/demo-playback.mjs so it needs
# no API key and renders identically every time.

Output docs/assets/demo.gif

Require node

Set Shell "zsh"
Set FontSize 19
Set Width 1320
Set Height 840
Set Padding 28
Set Margin 36
Set MarginFill "#6D28D9"
Set BorderRadius 12
Set WindowBar Colorful
Set WindowBarSize 40
Set Theme "Catppuccin Macchiato"

Hide
Type "clear"
Enter
Show

Sleep 600ms
Type "node scripts/demo-playback.mjs"
Sleep 400ms
Enter

# Playback self-paces (~19s). Hold to the end, then linger on the final frame.
Sleep 23s
