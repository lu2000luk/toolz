import base64
import zlib
import sys

def decode_and_decompress(input_string):
    """Decodes a base64 string and then decompresses it using zlib."""
    try:
        decoded_data = base64.b64decode(input_string)
        decompressed_data = zlib.decompress(decoded_data)
        return decompressed_data.decode('utf-8')
    except (base64.binascii.Error, zlib.error, UnicodeDecodeError) as e:
        return f"Error: {e}"

if __name__ == "__main__":
    print("Enter base64 encoded and zlib compressed strings (Ctrl+C or Ctrl+Z then Enter to exit):")
    try:
        for line in sys.stdin:
            stripped_line = line.strip()
            if not stripped_line:
                continue
            result = decode_and_decompress(stripped_line)
            print(f"Result: {result}")
    except KeyboardInterrupt:
        print("\nExiting.")