cmake_minimum_required(VERSION 3.28)
project(crx CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

FetchContent_Declare(json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz)
FetchContent_Declare(doctest
  URL https://github.com/doctest/doctest/archive/refs/tags/v2.4.12.tar.gz)
FetchContent_MakeAvailable(json doctest)

add_library(crx_engine STATIC
  engine/src/api.cpp)
target_include_directories(crx_engine PUBLIC engine/include)
target_link_libraries(crx_engine PUBLIC nlohmann_json::nlohmann_json)
target_compile_options(crx_engine PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-ffp-contract=off -Wall -Wextra -Wpedantic>)

add_executable(crx-cli engine/apps/cli/main.cpp)
target_link_libraries(crx-cli PRIVATE crx_engine)

enable_testing()
add_executable(crx_tests engine/tests/test_core.cpp)
target_link_libraries(crx_tests PRIVATE crx_engine doctest::doctest)
add_test(NAME core COMMAND crx_tests)
