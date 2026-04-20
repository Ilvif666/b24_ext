using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public static class Program
{
    private const string LycheePath = @"C:\Program Files\LycheeSlicer\LycheeSlicer.exe";
    private const string BambuPath = @"C:\Program Files\Bambu Studio\bambu-studio.exe";

    public static void Main()
    {
        try
        {
            string message = ReadMessage(Console.OpenStandardInput());
            string app = ReadJsonString(message, "app");
            string filename = ReadJsonString(message, "filename");

            if (!File.Exists(filename))
            {
                WriteMessage(false, "File not found: " + filename);
                return;
            }

            string exePath = "";
            if (String.Equals(app, "lychee", StringComparison.OrdinalIgnoreCase))
            {
                exePath = LycheePath;
            }
            else if (String.Equals(app, "bambu", StringComparison.OrdinalIgnoreCase))
            {
                exePath = BambuPath;
            }
            else
            {
                WriteMessage(false, "Unknown slicer: " + app);
                return;
            }

            if (!File.Exists(exePath))
            {
                WriteMessage(false, "Slicer not found: " + exePath);
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = exePath,
                Arguments = QuoteArgument(filename),
                UseShellExecute = false
            });

            WriteMessage(true, "");
        }
        catch (Exception error)
        {
            WriteMessage(false, error.Message);
        }
    }

    private static string ReadMessage(Stream input)
    {
        byte[] lengthBytes = ReadExactly(input, 4);
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > 1024 * 1024)
        {
            throw new InvalidDataException("Invalid message length: " + length);
        }

        byte[] messageBytes = ReadExactly(input, length);
        return Encoding.UTF8.GetString(messageBytes);
    }

    private static byte[] ReadExactly(Stream input, int count)
    {
        byte[] buffer = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(buffer, offset, count - offset);
            if (read == 0)
            {
                throw new EndOfStreamException("Native message stream ended early");
            }

            offset += read;
        }

        return buffer;
    }

    private static string ReadJsonString(string json, string property)
    {
        Match match = Regex.Match(
            json,
            "\"" + Regex.Escape(property) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\""
        );
        if (!match.Success)
        {
            return "";
        }

        return Regex.Unescape(match.Groups[1].Value);
    }

    private static void WriteMessage(bool ok, string error)
    {
        string json = ok
            ? "{\"ok\":true}"
            : "{\"ok\":false,\"error\":\"" + JsonEscape(error) + "\"}";
        byte[] messageBytes = Encoding.UTF8.GetBytes(json);
        byte[] lengthBytes = BitConverter.GetBytes(messageBytes.Length);
        Stream output = Console.OpenStandardOutput();
        output.Write(lengthBytes, 0, lengthBytes.Length);
        output.Write(messageBytes, 0, messageBytes.Length);
        output.Flush();
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string JsonEscape(string value)
    {
        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n");
    }
}
