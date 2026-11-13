// dcap — command line front-end for the Detailed Capture core (same dispatcher the Android app uses).
//   dcap <command> '<json args>' [--threads N] [--mem MB] [--quiet]
#include "dc/project.h"
#include <cstdio>
#include <cstring>
#include <iostream>

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: dcap <command> '<json args>' [--threads N] [--mem MB] [--quiet]\n");
        return 2;
    }
    std::string cmd = argv[1], args = argc > 2 && argv[2][0] != '-' ? argv[2] : "{}";
    dc::Ctx ctx;
    ctx.threads = 4;
    ctx.memoryBudgetMB = 1024;
    bool quiet = false;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--threads") && i + 1 < argc) ctx.threads = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--mem") && i + 1 < argc) ctx.memoryBudgetMB = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--quiet")) quiet = true;
    }
    if (!quiet)
        ctx.progress = [](const std::string& stage, double f, const std::string& detail) {
            fprintf(stderr, "\r[%5.1f%%] %-30s %-20s", f * 100, stage.c_str(), detail.c_str());
            fflush(stderr);
        };
    std::string out = dc::apiCall(cmd, args, ctx);
    if (!quiet) fprintf(stderr, "\n");
    std::cout << out << std::endl;
    return out.find("\"ok\":true") != std::string::npos ? 0 : 1;
}
