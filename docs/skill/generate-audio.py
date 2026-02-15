#!/usr/bin/env python3
# /// script
# dependencies = ["openai", "python-dotenv"]
# ///
"""Generate speech audio from text using OpenAI TTS API."""

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI


def main():
    parser = argparse.ArgumentParser(description="Generate speech audio from text")
    parser.add_argument("text", help="Text to convert to speech")
    parser.add_argument("-o", "--output", default="prompt.wav", help="Output WAV file (default: prompt.wav)")
    parser.add_argument("--voice", default="alloy", help="TTS voice (default: alloy)")
    parser.add_argument("--model", default="tts-1", help="TTS model (default: tts-1)")
    args = parser.parse_args()

    # Load .env from project root (two levels up from this script)
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    load_dotenv(env_path)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print(f"Error: OPENAI_API_KEY not found in environment or {env_path}", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=api_key)
    response = client.audio.speech.create(
        model=args.model,
        voice=args.voice,
        input=args.text,
        response_format="wav",
    )

    output_path = Path(args.output)
    response.write_to_file(output_path)
    print(f"Generated: {output_path} ({output_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
