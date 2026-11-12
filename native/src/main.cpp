#include "engine.hpp"
#include "httplib.h"

#include <filesystem>
#include <iostream>
#include <set>
#include <string>
#ifdef _WIN32
#include <shellapi.h>
#endif

namespace {
using capture::json;
httplib::Server* active_server = nullptr;

std::string utf8_path(const std::filesystem::path& path) {
    const auto value = path.u8string();
    return {reinterpret_cast<const char*>(value.data()), value.size()};
}

std::filesystem::path path_from_utf8(const std::string& value) {
    return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(value.data()), value.size()));
}

#ifdef _WIN32
BOOL WINAPI console_handler(DWORD event) {
    if ((event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT || event == CTRL_CLOSE_EVENT) && active_server) {
        active_server->stop();
        return TRUE;
    }
    return FALSE;
}
std::vector<std::string> arguments_utf8() {
    int count = 0;
    auto wide = CommandLineToArgvW(GetCommandLineW(), &count);
    std::vector<std::string> result;
    for (int i = 0; i < count; ++i) {
        const auto size = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, nullptr, 0, nullptr, nullptr);
        std::string value(static_cast<std::size_t>(size), '\0');
        WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, value.data(), size, nullptr, nullptr);
        value.pop_back(); result.push_back(std::move(value));
    }
    LocalFree(wide);
    return result;
}
#endif

void respond(httplib::Response& response, const json& data, int status = 200) {
    response.status = status;
    response.set_content(data.dump(), "application/json; charset=utf-8");
    response.set_header("Cache-Control", "no-store");
}

json parse_request(const httplib::Request& request) {
    if (request.body.empty()) return json::object();
    auto value = json::parse(request.body);
    if (!value.is_object()) throw std::invalid_argument("request body must be a JSON object");
    return value;
}
}  // namespace

int main(int argc, char** argv) {
    try {
        std::vector<std::string> args;
#ifdef _WIN32
        (void)argc; (void)argv;
        args = arguments_utf8();
#else
        args.assign(argv, argv + argc);
#endif
        std::filesystem::path data_dir = "data/sessions";
        std::filesystem::path web_dir = "frontend/dist";
        int port = 8765;
        for (std::size_t i = 1; i < args.size(); ++i) {
            if (args[i] == "--help") {
                std::cout << "SYNDAQ native simulation engine\n"
                          << "  --data-dir PATH   recording directory (default data/sessions)\n"
                          << "  --web-dir PATH    React build directory (default frontend/dist)\n"
                          << "  --port NUMBER     loopback port (default 8765)\n";
                return 0;
            }
            if (i + 1 >= args.size()) throw std::invalid_argument("missing argument value: " + args[i]);
            const auto option = args[i++];
            if (option == "--data-dir") data_dir = path_from_utf8(args[i]);
            else if (option == "--web-dir") web_dir = path_from_utf8(args[i]);
            else if (option == "--port") {
                port = std::stoi(args[i]);
                if (port < 1 || port > 65535) throw std::invalid_argument("port must be 1..65535");
            } else throw std::invalid_argument("unknown argument: " + option);
        }

        capture::CaptureEngine engine(data_dir);
        httplib::Server server;
        active_server = &server;
        server.set_payload_max_length(1024 * 1024);
        server.set_read_timeout(5, 0);
        server.set_write_timeout(15, 0);
        const std::set<std::string> allowed_origins{
            "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173",
            "http://localhost:8765", "http://127.0.0.1:8765"};
        server.set_pre_routing_handler([&](const httplib::Request& request, httplib::Response& response) {
            const auto origin = request.get_header_value("Origin");
            if (!origin.empty() && !allowed_origins.contains(origin)) {
                respond(response, {{"error", "origin is not allowed"}}, 403);
                return httplib::Server::HandlerResponse::Handled;
            }
            if (!origin.empty()) {
                response.set_header("Access-Control-Allow-Origin", origin);
                response.set_header("Vary", "Origin");
                response.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                response.set_header("Access-Control-Allow-Headers", "Content-Type");
            }
            response.set_header("X-Content-Type-Options", "nosniff");
            return httplib::Server::HandlerResponse::Unhandled;
        });
        server.Options(R"(.*)", [](const auto&, auto& response) { response.status = 204; });
        server.set_exception_handler([](const auto&, auto& response, std::exception_ptr exception) {
            try { if (exception) std::rethrow_exception(exception); }
            catch (const json::exception& error) { respond(response, {{"error", error.what()}}, 400); }
            catch (const std::invalid_argument& error) { respond(response, {{"error", error.what()}}, 400); }
            catch (const std::logic_error& error) { respond(response, {{"error", error.what()}}, 409); }
            catch (const std::exception& error) {
                const std::string message = error.what();
                respond(response, {{"error", message}}, message == "session not found" ? 404 : 500);
            }
        });

        server.Get("/api/health", [&](const auto&, auto& response) {
            respond(response, {{"ok", true}, {"service", "syndaq-native"}, {"version", "0.1.0"},
                {"mode", "simulation"}, {"source", "simulation"}, {"simulated", true},
                {"hardware_connected", false}, {"data_dir", utf8_path(engine.data_root())}});
        });
        server.Get("/api/devices", [&](const auto&, auto& response) { respond(response, {{"devices", engine.devices()}}); });
        server.Get("/api/status", [&](const auto&, auto& response) { respond(response, engine.status()); });
        server.Get("/api/preview", [&](const auto&, auto& response) { respond(response, engine.preview()); });
        server.Get("/api/snapshot", [&](const auto&, auto& response) { respond(response, engine.snapshot()); });
        auto start_handler = [&](const httplib::Request& request, httplib::Response& response) {
            const auto session = engine.start_recording(parse_request(request));
            respond(response, {{"session_id", session["id"]}, {"session", session}, {"status", engine.status()}}, 201);
        };
        auto stop_handler = [&](const httplib::Request&, httplib::Response& response) {
            respond(response, {{"session", engine.stop_recording()}, {"status", engine.status()}});
        };
        server.Post("/api/sessions/start", start_handler);
        server.Post("/api/sessions/stop", stop_handler);
        server.Post("/api/recordings/start", start_handler);
        server.Post("/api/recordings/stop", stop_handler);
        server.Get("/api/sessions", [&](const auto&, auto& response) { respond(response, {{"sessions", engine.sessions()}}); });
        server.Get(R"(/api/sessions/([A-Za-z0-9_-]+))", [&](const auto& request, auto& response) {
            respond(response, engine.session(request.matches[1]));
        });
        server.Get(R"(/api/files/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+))", [&](const auto& request, auto& response) {
            const auto id = request.matches[1].str();
            const auto filename = request.matches[2].str();
            const auto session = engine.session(id);
            bool permitted = filename == "manifest.json";
            for (const auto& stream : session["streams"]) if (stream.value("file", "") == filename) permitted = true;
            if (!permitted) { respond(response, {{"error", "file is not available"}}, 404); return; }
            const auto path = engine.session_path(id) / filename;
            if (!std::filesystem::is_regular_file(path)) { respond(response, {{"error", "file not found"}}, 404); return; }
            response.set_header("Content-Disposition", "attachment; filename=\"" + filename + "\"");
            response.set_file_content(utf8_path(path), filename == "manifest.json" ? "application/json" : "application/octet-stream");
        });

        web_dir = std::filesystem::absolute(web_dir);
        if (std::filesystem::is_directory(web_dir)) server.set_mount_point("/", utf8_path(web_dir));
        server.set_error_handler([&](const httplib::Request& request, httplib::Response& response) {
            if (response.status == 404 && !request.path.starts_with("/api/") &&
                request.method == "GET" && std::filesystem::path(request.path).extension().empty() &&
                std::filesystem::is_regular_file(web_dir / "index.html")) {
                response.status = 200;
                std::ifstream index(web_dir / "index.html", std::ios::binary);
                std::string body((std::istreambuf_iterator<char>(index)), std::istreambuf_iterator<char>());
                response.set_content(std::move(body), "text/html; charset=utf-8");
                return;
            }
            if (request.path.starts_with("/api/") && response.body.empty()) respond(response, {{"error", "API endpoint not found"}}, response.status);
        });
#ifdef _WIN32
        SetConsoleCtrlHandler(console_handler, TRUE);
#endif
        std::cout << "SYNDAQ simulation engine listening on http://127.0.0.1:" << port << "\n"
                  << "Recordings: " << utf8_path(engine.data_root()) << "\n" << std::flush;
        const auto ok = server.listen("127.0.0.1", port);
        active_server = nullptr;
        if (!ok) { std::cerr << "Cannot bind loopback port " << port << '\n'; return 1; }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Native engine error: " << error.what() << '\n';
        return 1;
    }
}
