#[[
Makes ggml's precompiled Metal libraries available to an executable at run
time. ggml looks for default.metallib in the Resources of the bundle holding
its code, then next to the running executable: a bundle target gets the files
in Contents/Resources, any other executable gets them copied beside it on every
build. Does nothing unless MUSCRIPTOR_METAL_PRECOMPILED is on.

inTarget  An executable, app bundle or plugin bundle target.
]]
function(muscriptor_add_metal_library inTarget)
    get_property(libraries GLOBAL PROPERTY MUSCRIPTOR_METAL_LIBRARIES)

    if(NOT libraries)
        return()
    endif()

    get_target_property(is_app ${inTarget} MACOSX_BUNDLE)
    get_target_property(is_bundle ${inTarget} BUNDLE)

    if(is_app OR is_bundle)
        add_dependencies(${inTarget} ggml-metal-lib)
        target_sources(${inTarget} PRIVATE ${libraries})
        set_source_files_properties(${libraries}
            TARGET_DIRECTORY ${inTarget}
            PROPERTIES GENERATED TRUE MACOSX_PACKAGE_LOCATION Resources)
    else()
        # Always runs, so a rebuilt or deleted copy is replaced without a relink.
        add_custom_target(${inTarget}_metal_library
            COMMAND ${CMAKE_COMMAND} -E make_directory $<TARGET_FILE_DIR:${inTarget}>
            COMMAND ${CMAKE_COMMAND} -E copy_if_different ${libraries} $<TARGET_FILE_DIR:${inTarget}>
            VERBATIM)
        add_dependencies(${inTarget}_metal_library ggml-metal-lib)
        add_dependencies(${inTarget} ${inTarget}_metal_library)
    endif()
endfunction()
